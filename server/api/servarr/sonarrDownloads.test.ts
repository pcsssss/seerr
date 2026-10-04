import SonarrDownloadsAPI, {
  type SonarrRelease,
} from '@server/api/servarr/sonarrDownloads';
import type { AxiosInstance } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

function build() {
  const api = new SonarrDownloadsAPI({
    url: 'http://localhost:8989/api/v3',
    apiKey: 'test',
  });
  return { api, axios: (api as unknown as { axios: AxiosInstance }).axios };
}
describe('Sonarr download operations', () => {
  afterEach(() => mock.restoreAll());
  it('filters ignored history series queries and reports bounded truncation', async () => {
    const { api, axios } = build();
    const get = mock.method(
      axios,
      'get',
      async (_path: string, config: { params: { page: number } }) => ({
        data: {
          totalRecords: 999,
          records: [
            {
              episodeId: 1,
              seriesId: 15,
              date: 'now',
              sourceTitle: 'Industry',
              eventType: 'grabbed',
              data: { downloadUrl: 'secret' },
            },
            { episodeId: 2, seriesId: 16 },
            { episodeId: 1, seriesId: 16 },
          ],
          page: config.params.page,
        },
      })
    );
    const result = await api.downloadHistory(15, new Set([1]));
    assert.equal(get.mock.callCount(), 3);
    assert.equal(result.records.length, 3);
    assert.equal(result.truncated, true);
    assert.ok(
      result.records.every((r) => r.seriesId === 15 && r.episodeId === 1)
    );
  });
  it('stops at the end of history and discloses a full queue', async () => {
    const { api, axios } = build();
    const get = mock.method(axios, 'get', async () => ({
      data: { totalRecords: 1, records: [{ episodeId: 1 }] },
    }));
    assert.equal(
      (await api.downloadHistory(15, new Set([1]))).truncated,
      false
    );
    assert.equal(get.mock.callCount(), 1);
    get.mock.restore();
    mock.method(axios, 'get', async () => ({
      data: { records: [], totalRecords: 1001 },
    }));
    assert.equal((await api.downloadQueue()).truncated, true);
  });
  it('uses an explicit episode or series/season search with a bounded timeout', async () => {
    const { api, axios } = build();
    const get = mock.method(axios, 'get', async () => ({ data: [] }));
    await api.downloadReleases(15, 2);
    await api.downloadReleases(15, 3, 31);
    assert.deepEqual(get.mock.calls[0].arguments[1], {
      params: { seriesId: 15, seasonNumber: 2 },
      timeout: 45000,
    });
    assert.deepEqual(get.mock.calls[1].arguments[1], {
      params: { episodeId: 31 },
      timeout: 45000,
    });
  });
  it('posts only Sonarr cached identity, never release URLs or override payloads', async () => {
    const { api, axios } = build();
    const post = mock.method(axios, 'post', async () => ({}));
    await api.grabDownload({
      guid: 'cached-id',
      indexerId: 2,
      downloadUrl: 'http://arbitrary.test',
    } as unknown as SonarrRelease);
    assert.deepEqual(post.mock.calls[0].arguments, [
      '/release',
      { guid: 'cached-id', indexerId: 2 },
      { timeout: 15000 },
    ]);
  });
});
