import type { EpisodeResult } from '@server/api/servarr/sonarr';
import type {
  SonarrDownloadHistory,
  SonarrDownloadQueue,
  SonarrRelease,
} from '@server/api/servarr/sonarrDownloads';
import type {
  TvDownloadEpisode,
  TvDownloadRelease,
} from '@server/interfaces/api/tvDownloadInterfaces';
import { LRUCache } from 'lru-cache';
import { randomBytes } from 'node:crypto';

export class DownloadError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
export function positiveId(value: unknown, allowZero = false): number {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new DownloadError(400, 'Invalid identifier.');
  if (!/^(0|[1-9]\d*)$/.test(String(value)))
    throw new DownloadError(400, 'Invalid identifier.');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1))
    throw new DownloadError(400, 'Invalid identifier.');
  return id;
}
// Upstream free text can include headers, quoted credentials and private paths.
// Prefer losing ambiguous diagnostic text to exposing a credential or filesystem location.
export function downloadText(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/(?:https?:\/\/|magnet:)[^\s<>"']+/gi, '[link removed]')
        .replace(
          /["']?\b(?:api[-_]?key|token|password|authorization)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"']+)|[^\s,;"']+)/gi,
          '[credential removed]'
        )
        .replace(
          /["'](?:[a-z]:[\\/]|\\\\|\/?(?:\.\.?|~)?\/)[^"'\r\n]*["']/gi,
          '[path removed]'
        )
        .replace(
          /(?:[a-z]:[\\/]|\\\\|(?:^|(?<=[\s(:=]))(?:\.{1,2}|~)?\/)[^\r\n,;<>"']+/gi,
          '[path removed]'
        )
        .replace(/\b[\w.-]+(?:[\\/][\w .-]+)+/g, '[path removed]')
        // Any remaining separator may belong to a partially redacted private path.
        .replace(/^[\s\S]*[\\/][\s\S]*$/, '')
        .slice(0, 500)
    : '';
}
export function mapDownloadEpisode(
  ep: EpisodeResult,
  seriesMonitored: boolean,
  seasonMonitored: boolean,
  queue: SonarrDownloadQueue[],
  history: SonarrDownloadHistory[]
): TvDownloadEpisode {
  const items = queue.filter(
    (q) => q.episodeId === ep.id && q.seriesId === ep.seriesId
  );
  return {
    id: ep.id,
    seasonNumber: ep.seasonNumber,
    episodeNumber: ep.episodeNumber,
    title: downloadText(ep.title),
    hasFile: ep.hasFile,
    monitored: ep.monitored && seriesMonitored && seasonMonitored,
    airDateUtc: ep.airDateUtc,
    state: ep.hasFile
      ? 'imported'
      : items.length
        ? 'queued'
        : !ep.monitored || !seriesMonitored || !seasonMonitored
          ? 'unmonitored'
          : Date.parse(ep.airDateUtc) > Date.now()
            ? 'unaired'
            : 'missing',
    queue: items.map((q) => ({
      title: downloadText(q.title),
      status: downloadText(q.status),
      trackedStatus: downloadText(q.trackedDownloadStatus),
      trackedState: downloadText(q.trackedDownloadState),
      progress:
        q.size > 0 && Number.isFinite(q.sizeleft)
          ? Math.max(0, Math.min(100, (1 - q.sizeleft / q.size) * 100))
          : null,
      messages: (q.statusMessages ?? [])
        .slice(0, 20)
        .flatMap((m) => [m.title, ...m.messages])
        .map(downloadText),
    })),
    history: history
      .filter(
        (h) =>
          h.episodeId === ep.id &&
          (h.seriesId === undefined || h.seriesId === ep.seriesId)
      )
      .slice(0, 10)
      .map((h) => ({
        date: h.date,
        eventType: downloadText(h.eventType),
        title: downloadText(h.sourceTitle),
        message: h.data?.message ? downloadText(h.data.message) : undefined,
      })),
  };
}
export function releaseEpisodes(
  release: SonarrRelease,
  seriesId: number,
  seasonNumber: number,
  episodes: EpisodeResult[],
  episodeId?: number
): EpisodeResult[] {
  if (
    release.mappedSeriesId !== seriesId ||
    release.mappedSeasonNumber !== seasonNumber
  )
    return [];
  const ids = release.mappedEpisodeInfo?.map((ep) => ep.id) ?? [];
  if (ids.length > 1000) return [];
  const matched = episodes.filter(
    (ep) =>
      ids.includes(ep.id) &&
      ep.seriesId === seriesId &&
      ep.seasonNumber === seasonNumber
  );
  if (
    !matched.length ||
    matched.length !== ids.length ||
    (episodeId !== undefined && !ids.includes(episodeId))
  )
    return [];
  return matched;
}
export function releaseDuplicate(
  episodes: EpisodeResult[],
  queue: SonarrDownloadQueue[]
): boolean {
  return episodes.some(
    (ep) =>
      ep.hasFile ||
      queue.some((q) => q.seriesId === ep.seriesId && q.episodeId === ep.id)
  );
}
export function publicRelease(
  release: SonarrRelease,
  duplicate: boolean,
  token?: string
): TvDownloadRelease {
  return {
    token,
    title: downloadText(release.title),
    indexer: downloadText(release.indexer),
    quality: downloadText(release.quality?.quality?.name),
    size: release.size,
    seeders: release.seeders ?? null,
    protocol: downloadText(String(release.protocol)),
    fullSeason: release.fullSeason,
    episodeNumbers: release.mappedEpisodeNumbers ?? [],
    rejections: (release.rejections ?? []).slice(0, 20).map(downloadText),
    rejected: release.rejected || !!release.rejections?.length,
    duplicate,
  };
}
export interface SearchBinding {
  userId: number;
  tmdbId: number;
  serverKey: string;
  seriesId: number;
  seasonNumber: number;
  episodeId?: number;
  requestId?: number;
  is4k: boolean;
}
interface SearchEntry {
  binding: SearchBinding;
  release: SonarrRelease;
  expiresAt: number;
}
export class DownloadSearchTokens {
  private cache = new LRUCache<string, SearchEntry>({
    max: 500,
    ttl: 5 * 60 * 1000,
  });
  add(binding: SearchBinding, release: SonarrRelease) {
    const token = randomBytes(24).toString('hex');
    // Retain only verified identity, mapped episodes and warning state, not upstream URLs.
    this.cache.set(token, {
      binding,
      release: {
        guid: release.guid,
        indexerId: release.indexerId,
        title: downloadText(release.title),
        indexer: downloadText(release.indexer),
        size: release.size,
        protocol: release.protocol,
        fullSeason: release.fullSeason,
        mappedSeriesId: release.mappedSeriesId,
        mappedSeasonNumber: release.mappedSeasonNumber,
        mappedEpisodeInfo: release.mappedEpisodeInfo?.map(({ id }) => ({ id })),
        rejected: release.rejected,
        rejections: release.rejections?.slice(0, 20).map(downloadText),
        downloadAllowed: release.downloadAllowed,
      },
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return token;
  }
  read(token: unknown, binding: SearchBinding) {
    if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token))
      throw new DownloadError(400, 'Invalid search token.');
    const entry = this.cache.get(token);
    if (!entry || entry.expiresAt <= Date.now())
      throw new DownloadError(
        409,
        'Search expired or already used. Search again.'
      );
    if (JSON.stringify(entry.binding) !== JSON.stringify(binding))
      throw new DownloadError(403, 'Search does not belong to this selection.');
    return entry.release;
  }
  consume(token: string) {
    this.cache.delete(token);
  }
}
