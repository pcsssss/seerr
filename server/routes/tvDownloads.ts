import SonarrDownloadsAPI from '@server/api/servarr/sonarrDownloads';
import { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import {
  DownloadError,
  DownloadSearchTokens,
  downloadText,
  mapDownloadEpisode,
  positiveId,
  publicRelease,
  releaseDuplicate,
  releaseEpisodes,
} from '@server/lib/tvDownloads';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const tokens = new DownloadSearchTokens();
const selectionSchema = z
  .object({
    is4k: z.boolean(),
    requestId: z.number().int().positive().safe().optional(),
    seasonNumber: z.number().int().nonnegative().safe(),
    episodeId: z.number().int().positive().safe().optional(),
  })
  .strict();
const grabSchema = selectionSchema
  .extend({
    token: z.string().regex(/^[a-f0-9]{48}$/),
    confirmRejected: z.boolean(),
    confirmDuplicate: z.boolean(),
  })
  .strict();

type Selection = z.infer<typeof selectionSchema>;
export async function resolveDownloads(
  tmdbId: number,
  is4k: boolean,
  requestId?: number
) {
  const media = await Media.getMedia(tmdbId, MediaType.TV);
  if (!media?.tvdbId)
    throw new DownloadError(
      404,
      'No Sonarr series mapping yet. Approve the request and refresh later.'
    );
  const request =
    requestId === undefined
      ? undefined
      : media.requests.find((r) => r.id === requestId && r.is4k === is4k);
  if (requestId !== undefined && !request)
    throw new DownloadError(
      404,
      'Request does not belong to this series and version.'
    );
  const serviceId =
    request &&
    request.serverId !== null &&
    request.serverId !== undefined &&
    request.serverId >= 0
      ? request.serverId
      : is4k
        ? media.serviceId4k
        : media.serviceId;
  const servers = getSettings().sonarr;
  const server =
    serviceId !== undefined && serviceId !== null
      ? servers.find((s) => s.id === serviceId && s.is4k === is4k)
      : servers.find((s) => s.isDefault && s.is4k === is4k);
  if (!server)
    throw new DownloadError(409, 'The mapped Sonarr server is not configured.');
  const api = new SonarrDownloadsAPI({
    url: SonarrDownloadsAPI.buildUrl(server, '/api/v3'),
    apiKey: server.apiKey,
  });
  const series = await api.downloadSeries(media.tvdbId);
  if (series.length !== 1 || !series[0].id)
    throw new DownloadError(
      404,
      'Series not found uniquely on the mapped Sonarr server.'
    );
  const seriesId = series[0].id;
  const episodes = (await api.downloadEpisodes(seriesId)).filter(
    (ep) => ep.seriesId === seriesId
  );
  const serverKey = createHash('sha256')
    .update(
      JSON.stringify([
        server.id,
        server.hostname,
        server.port,
        server.baseUrl,
        server.useSsl,
        server.apiKey,
      ])
    )
    .digest('hex');
  return { api, series: series[0], seriesId, episodes, server, serverKey };
}
function validateSelection(
  selection: Selection,
  context: Awaited<ReturnType<typeof resolveDownloads>>
) {
  if (!context.episodes.some((e) => e.seasonNumber === selection.seasonNumber))
    throw new DownloadError(400, 'Season does not belong to this series.');
  if (
    selection.episodeId !== undefined &&
    !context.episodes.some(
      (e) =>
        e.id === selection.episodeId &&
        e.seasonNumber === selection.seasonNumber
    )
  )
    throw new DownloadError(
      400,
      'Episode does not belong to this season and series.'
    );
}
function safeError(error: unknown) {
  return error instanceof DownloadError
    ? { status: error.status, message: error.message }
    : {
        status: 502,
        message:
          'Sonarr could not complete the operation. Refresh or search again. A timed-out grab may already have been accepted; check progress before retrying.',
      };
}
const routes = Router({ mergeParams: true });
routes.use(isAuthenticated(Permission.MANAGE_REQUESTS));
routes.use(rateLimit({ windowMs: 60000, limit: 60 }));
const searchLimit = rateLimit({ windowMs: 60000, limit: 5 });
routes.get<{ id: string }>('/', async (req, res, next) => {
  try {
    if (
      req.query.is4k !== undefined &&
      req.query.is4k !== 'true' &&
      req.query.is4k !== 'false'
    )
      throw new DownloadError(400, 'Invalid version.');
    const is4k = req.query.is4k === 'true';
    const requestId =
      req.query.requestId === undefined
        ? undefined
        : positiveId(req.query.requestId);
    const context = await resolveDownloads(
      positiveId(req.params.id),
      is4k,
      requestId
    );
    const [queue, history] = await Promise.all([
      context.api.downloadQueue(),
      context.api.downloadHistory(
        context.seriesId,
        new Set(context.episodes.map((e) => e.id))
      ),
    ]);
    res.json({
      serverName: downloadText(context.server.name),
      is4k,
      seriesMonitored: context.series.monitored,
      queueTruncated: queue.truncated,
      historyTruncated: history.truncated,
      episodes: context.episodes.map((ep) =>
        mapDownloadEpisode(
          ep,
          context.series.monitored,
          context.series.seasons.find((s) => s.seasonNumber === ep.seasonNumber)
            ?.monitored ?? false,
          queue.records,
          history.records
        )
      ),
    });
  } catch (error) {
    next(safeError(error));
  }
});
routes.post<{ id: string }>('/search', searchLimit, async (req, res, next) => {
  try {
    const parsed = selectionSchema.safeParse(req.body);
    if (!parsed.success)
      throw new DownloadError(400, 'Invalid search selection.');
    const selection = parsed.data;
    const tmdbId = positiveId(req.params.id);
    const context = await resolveDownloads(
      tmdbId,
      selection.is4k,
      selection.requestId
    );
    validateSelection(selection, context);
    const [releases, queue] = await Promise.all([
      context.api.downloadReleases(
        context.seriesId,
        selection.seasonNumber,
        selection.episodeId
      ),
      context.api.downloadQueue(),
    ]);
    // Incomplete queue information cannot safely establish duplicate state.
    if (queue.truncated)
      throw new DownloadError(
        409,
        'Sonarr queue is too large to verify duplicates. Try again after the queue clears.'
      );
    const binding = {
      userId: req.user!.id,
      tmdbId,
      serverKey: context.serverKey,
      seriesId: context.seriesId,
      ...selection,
    };
    res.json({
      expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
      truncated: releases.length > 100,
      releases: releases.slice(0, 100).map((release) => {
        const matched = releaseEpisodes(
          release,
          context.seriesId,
          selection.seasonNumber,
          context.episodes,
          selection.episodeId
        );
        const token =
          matched.length &&
          release.downloadAllowed &&
          release.guid &&
          release.guid.length <= 4096 &&
          Number.isSafeInteger(release.indexerId) &&
          release.indexerId > 0
            ? tokens.add(binding, release)
            : undefined;
        return publicRelease(
          release,
          releaseDuplicate(matched, queue.records),
          token
        );
      }),
    });
  } catch (error) {
    next(safeError(error));
  }
});
routes.post<{ id: string }>('/grab', async (req, res, next) => {
  try {
    const parsed = grabSchema.safeParse(req.body);
    if (!parsed.success)
      throw new DownloadError(400, 'Invalid download selection.');
    const { token, confirmRejected, confirmDuplicate, ...selection } =
      parsed.data;
    const tmdbId = positiveId(req.params.id);
    const context = await resolveDownloads(
      tmdbId,
      selection.is4k,
      selection.requestId
    );
    validateSelection(selection, context);
    const release = tokens.read(token, {
      userId: req.user!.id,
      tmdbId,
      serverKey: context.serverKey,
      seriesId: context.seriesId,
      ...selection,
    });
    const matched = releaseEpisodes(
      release,
      context.seriesId,
      selection.seasonNumber,
      context.episodes,
      selection.episodeId
    );
    if (!matched.length)
      throw new DownloadError(
        409,
        'Release no longer matches this selection. Search again.'
      );
    const queue = await context.api.downloadQueue();
    if (queue.truncated)
      throw new DownloadError(
        409,
        'Unable to verify duplicates while the queue is truncated.'
      );
    if ((release.rejected || release.rejections?.length) && !confirmRejected)
      throw new DownloadError(
        409,
        'Confirm the rejection reasons before downloading.'
      );
    if (releaseDuplicate(matched, queue.records) && !confirmDuplicate)
      throw new DownloadError(
        409,
        'Episodes are already imported or queued. Confirm a possible duplicate before downloading.'
      );
    // Consume before awaiting the mutation: concurrent submissions cannot grab twice.
    tokens.read(token, {
      userId: req.user!.id,
      tmdbId,
      serverKey: context.serverKey,
      seriesId: context.seriesId,
      ...selection,
    });
    tokens.consume(token);
    await context.api.grabDownload(release);
    res
      .status(202)
      .json({ message: 'Release sent to Sonarr. Refresh progress shortly.' });
  } catch (error) {
    next(safeError(error));
  }
});
export default routes;
