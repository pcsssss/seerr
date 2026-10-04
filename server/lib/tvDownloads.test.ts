import type { EpisodeResult } from '@server/api/servarr/sonarr';
import type {
  SonarrDownloadHistory,
  SonarrDownloadQueue,
  SonarrRelease,
} from '@server/api/servarr/sonarrDownloads';
import {
  DownloadSearchTokens,
  downloadText,
  mapDownloadEpisode,
  positiveId,
  publicRelease,
  releaseEpisodes,
} from '@server/lib/tvDownloads';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const ep = {
  id: 31,
  seriesId: 15,
  seasonNumber: 3,
  episodeNumber: 8,
  title: 'Industry',
  monitored: true,
  hasFile: false,
  airDateUtc: '2024-01-01T00:00:00Z',
} as EpisodeResult;
const release = {
  guid: 'https://indexer.test?apikey=secret',
  indexerId: 1,
  title: 'Industry',
  indexer: 'Indexer',
  mappedSeriesId: 15,
  mappedSeasonNumber: 3,
  mappedEpisodeInfo: [{ id: 31 }],
  mappedEpisodeNumbers: [8],
  downloadAllowed: true,
  rejected: false,
  size: 100,
  protocol: 'torrent',
  fullSeason: false,
} as SonarrRelease;
const binding = {
  userId: 1,
  tmdbId: 123,
  serverKey: 'normal',
  seriesId: 15,
  is4k: false,
  seasonNumber: 3,
  episodeId: 31,
};

describe('TV download diagnostics safety helpers', () => {
  it('strictly validates safe decimal identifiers', () => {
    assert.equal(positiveId('15'), 15);
    assert.equal(positiveId(0, true), 0);
    for (const id of [
      '0',
      '-1',
      '1x',
      '1.1',
      '1e2',
      '01',
      ' 1',
      '',
      [],
      {},
      '9007199254740992',
    ])
      assert.throws(() => positiveId(id));
  });
  it('redacts credential-bearing URLs and key assignments from free text', () => {
    assert.equal(
      downloadText('Failed https://indexer.test/x?apikey=secret token=secret'),
      'Failed [link removed] [credential removed]'
    );
    assert.equal(downloadText('magnet:?xt=hash'), '[link removed]');
    assert.equal(downloadText('x'.repeat(1000)).length, 500);
  });
  it('redacts whole authorization headers and quoted credential assignments', () => {
    for (const input of [
      'Authorization: Bearer secret-value',
      'authorization=Basic c2VjcmV0OnZhbHVl',
      '"Authorization": "Bearer secret value"',
      "Authorization: Bearer 'secret value'",
      'password="secret value with spaces"',
      "password='secret value with spaces'",
      'token="secret \\"quoted\\" value"',
      'api_key = "secret value"; warning',
    ]) {
      const output = downloadText(input);
      assert.ok(output.includes('[credential removed]'), input);
      assert.ok(
        !/secret|value|c2VjcmV0|Bearer|Basic|quoted/.test(output),
        output
      );
    }
  });
  it('scrubs absolute, quoted, relative and Windows paths from free text', () => {
    for (const path of [
      '/downloads/private/file.mkv',
      '"/downloads/private folder/file.mkv"',
      '/downloads/private folder/file.mkv',
      'C:\\downloads\\private\\file.mkv',
      '"C:\\downloads\\private folder\\file.mkv"',
      '\\\\nas\\private\\file.mkv',
      '~/private/file.mkv',
      '../private/file.mkv',
      'downloads/private/file.mkv',
    ]) {
      const output = downloadText(`Import failed: ${path}`);
      assert.ok(output.includes('[path removed]'), path);
      assert.ok(!/private|file\.mkv|downloads|nas/.test(output), output);
    }
    assert.equal(
      downloadText('Import failed: permission denied'),
      'Import failed: permission denied'
    );
  });
  it('omits ambiguous residual paths containing apostrophes and parentheses', () => {
    assert.equal(
      downloadText(
        "Import failed: /downloads/user's private (backup)/episode.mkv"
      ),
      ''
    );
  });
  it('omits ambiguous residual paths across public episode, queue, history and release mappings', () => {
    const unsafe =
      "Import failed: /downloads/user's private (backup)/episode.mkv";
    const mapped = mapDownloadEpisode(
      { ...ep, title: unsafe },
      true,
      true,
      [
        {
          seriesId: 15,
          episodeId: 31,
          title: unsafe,
          status: unsafe,
          trackedDownloadStatus: unsafe,
          trackedDownloadState: unsafe,
          size: 1,
          sizeleft: 0,
          statusMessages: [{ title: unsafe, messages: [unsafe] }],
        },
      ],
      [
        {
          seriesId: 15,
          episodeId: 31,
          date: '2024-01-01',
          eventType: unsafe,
          sourceTitle: unsafe,
          data: { message: unsafe },
        },
      ]
    );
    assert.equal(mapped.title, '');
    assert.deepEqual(mapped.queue[0], {
      title: '',
      status: '',
      trackedStatus: '',
      trackedState: '',
      progress: 100,
      messages: ['', ''],
    });
    assert.deepEqual(mapped.history[0], {
      date: '2024-01-01',
      eventType: '',
      title: '',
      message: '',
    });
    const publicResult = publicRelease(
      {
        ...release,
        title: unsafe,
        indexer: unsafe,
        protocol: unsafe,
        quality: { quality: { name: unsafe } },
        rejections: [unsafe],
      } as SonarrRelease,
      false
    );
    assert.equal(publicResult.title, '');
    assert.equal(publicResult.indexer, '');
    assert.equal(publicResult.protocol, '');
    assert.equal(publicResult.quality, '');
    assert.deepEqual(publicResult.rejections, ['']);
    assert.ok(
      !/downloads|user|private|backup|episode\.mkv/.test(
        JSON.stringify([mapped, publicResult])
      )
    );
  });
  it('redacts credentials and paths across every public diagnostic mapping', () => {
    const unsafe =
      'Authorization: Bearer secret-value; password="secret phrase"; Import failed: /downloads/private/file.mkv';
    const mapped = mapDownloadEpisode(
      { ...ep, title: unsafe },
      true,
      true,
      [
        {
          seriesId: 15,
          episodeId: 31,
          title: unsafe,
          status: unsafe,
          trackedDownloadStatus: unsafe,
          trackedDownloadState: unsafe,
          size: 1,
          sizeleft: 0,
          statusMessages: [{ title: unsafe, messages: [unsafe] }],
        },
      ],
      [
        {
          seriesId: 15,
          episodeId: 31,
          date: '2024-01-01',
          eventType: unsafe,
          sourceTitle: unsafe,
          data: { message: unsafe },
        },
      ]
    );
    const publicResult = publicRelease(
      {
        ...release,
        title: unsafe,
        indexer: unsafe,
        protocol: unsafe,
        quality: { quality: { name: unsafe } },
        rejections: [unsafe],
      } as SonarrRelease,
      false
    );
    for (const result of [mapped, publicResult]) {
      const text = JSON.stringify(result);
      assert.ok(!/secret|phrase|private|file\.mkv/.test(text), text);
      assert.ok(text.includes('[credential removed]'));
      assert.ok(text.includes('[path removed]'));
    }
  });
  it('does not invent a cause for warnings with no messages', () => {
    const queue = [
      {
        seriesId: 15,
        episodeId: 31,
        status: 'warning',
        trackedDownloadStatus: 'warning',
        trackedDownloadState: 'downloading',
        title: 'Season pack',
        size: 1000,
        sizeleft: 982,
        statusMessages: [],
      },
    ] as SonarrDownloadQueue[];
    const mapped = mapDownloadEpisode(ep, true, true, queue, []);
    assert.equal(mapped.state, 'queued');
    assert.equal(mapped.queue[0].progress?.toFixed(1), '1.8');
    assert.deepEqual(mapped.queue[0].messages, []);
    assert.equal(mapDownloadEpisode(ep, true, true, [], []).state, 'missing');
    assert.equal(
      mapDownloadEpisode({ ...ep, hasFile: true }, true, true, [], []).state,
      'imported'
    );
    assert.equal(
      mapDownloadEpisode(ep, false, true, [], []).state,
      'unmonitored'
    );
    assert.equal(
      mapDownloadEpisode(ep, true, false, [], []).state,
      'unmonitored'
    );
  });
  it('represents the Industry fixture as S2 queued and S3E8 imported, not S3E1', () => {
    const season2 = Array.from({ length: 8 }, (_, i) => ({
      ...ep,
      id: 100 + i,
      seasonNumber: 2,
      episodeNumber: i + 1,
    }));
    const season3 = Array.from({ length: 8 }, (_, i) => ({
      ...ep,
      id: 200 + i,
      episodeNumber: i + 1,
      hasFile: i === 7,
    }));
    const queue = season2.map((e) => ({
      seriesId: 15,
      episodeId: e.id,
      title: 'Industry S02 pack',
      status: 'warning',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'downloading',
      size: 1000,
      sizeleft: 982,
      statusMessages: [],
    })) as SonarrDownloadQueue[];
    assert.ok(
      season2.every(
        (e) => mapDownloadEpisode(e, true, true, queue, []).state === 'queued'
      )
    );
    const mapped = season3.map((e) =>
      mapDownloadEpisode(e, true, true, queue, [])
    );
    assert.deepEqual(
      mapped.filter((e) => e.state === 'imported').map((e) => e.episodeNumber),
      [8]
    );
    assert.deepEqual(
      mapped.filter((e) => e.state === 'missing').map((e) => e.episodeNumber),
      [1, 2, 3, 4, 5, 6, 7]
    );
  });
  it('strips private history data and sanitizes titles and queue messages', () => {
    const mapped = mapDownloadEpisode(
      ep,
      true,
      true,
      [
        {
          seriesId: 15,
          episodeId: 31,
          size: 1,
          sizeleft: 0,
          title: 'https://test?apikey=secret',
          statusMessages: [{ title: 'Warning', messages: ['token=secret'] }],
        },
      ] as SonarrDownloadQueue[],
      [
        {
          episodeId: 31,
          seriesId: 15,
          sourceTitle: 'https://test?apikey=secret',
          date: '2024-01-01',
          eventType: 'grabbed',
          data: { downloadUrl: 'secret', message: 'Failure token=secret' },
        },
      ] as unknown as SonarrDownloadHistory[]
    );
    assert.ok(!JSON.stringify(mapped).includes('secret'));
    assert.ok(!('data' in mapped.history[0]));
    assert.equal(mapped.history[0].message, 'Failure [credential removed]');
  });
  it('requires exact mapped series, season and episode coverage for a selectable release', () => {
    assert.equal(releaseEpisodes(release, 15, 3, [ep], 31).length, 1);
    for (const bad of [
      { ...release, mappedSeriesId: 99 },
      { ...release, mappedSeasonNumber: 2 },
      { ...release, mappedEpisodeInfo: [{ id: 999 }] },
      { ...release, mappedEpisodeInfo: [{ id: 31 }, { id: 999 }] },
    ])
      assert.deepEqual(releaseEpisodes(bad, 15, 3, [ep], 31), []);
  });
  it('returns only the public release allowlist without URLs or credentials', () => {
    const mapped = publicRelease(
      { ...release, rejections: ['URL https://x.test?apikey=secret'] },
      false
    );
    assert.ok(!JSON.stringify(mapped).includes('secret'));
    assert.ok(!('guid' in mapped));
    assert.ok(!('downloadUrl' in mapped));
  });
});
describe('TV download search tokens', () => {
  it('binds tokens to user, mapping, series, version, request and search target', () => {
    const tokens = new DownloadSearchTokens();
    const token = tokens.add(binding, release);
    assert.equal(tokens.read(token, binding).guid, release.guid);
    for (const changed of [
      { userId: 2 },
      { tmdbId: 456 },
      { serverKey: '4k' },
      { seriesId: 16 },
      { is4k: true },
      { seasonNumber: 2 },
      { episodeId: 32 },
      { requestId: 10 },
    ])
      assert.throws(() => tokens.read(token, { ...binding, ...changed }));
    tokens.consume(token);
    assert.throws(() => tokens.read(token, binding), /expired or already used/);
  });
  it('expires after five minutes and evicts oldest entries after 500 releases', () => {
    const tokens = new DownloadSearchTokens();
    const token = tokens.add(binding, release);
    const original = Date.now();
    const clock = mock.method(Date, 'now', () => original + 300001);
    assert.throws(() => tokens.read(token, binding), /expired/);
    clock.mock.restore();
    const oldest = tokens.add(binding, release);
    for (let i = 0; i < 500; i++) tokens.add(binding, release);
    assert.throws(() => tokens.read(oldest, binding), /expired/);
  });
});
