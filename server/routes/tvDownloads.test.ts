import type { EpisodeResult, SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrDownloadsAPI, {
  type SonarrRelease,
} from '@server/api/servarr/sonarrDownloads';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings, type SonarrSettings } from '@server/lib/settings';
import routes from '@server/routes/tvDownloads';
import type { AxiosInstance } from 'axios';
import express, { type ErrorRequestHandler } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import nodePath from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

const selection = { is4k: false, seasonNumber: 2, episodeId: 21 };
const episode = {
  id: 21,
  seriesId: 15,
  seasonNumber: 2,
  episodeNumber: 1,
  title: 'Industry',
  monitored: true,
  hasFile: false,
  airDateUtc: '2024-01-01T00:00:00Z',
} as EpisodeResult;
const series = {
  id: 15,
  tvdbId: 371796,
  monitored: true,
  seasons: [{ seasonNumber: 2, monitored: true }],
} as SonarrSeries;
const release = {
  guid: 'cached-guid',
  indexerId: 1,
  title: 'Industry S02',
  indexer: 'Indexer',
  size: 1000,
  fullSeason: true,
  protocol: 'torrent',
  mappedSeriesId: 15,
  mappedSeasonNumber: 2,
  mappedEpisodeInfo: [{ id: 21 }],
  mappedEpisodeNumbers: [1],
  downloadAllowed: true,
  rejected: false,
  rejections: [],
} as SonarrRelease;
const media = () =>
  ({
    tvdbId: 371796,
    serviceId: 0,
    serviceId4k: 2,
    requests: [
      { id: 10, serverId: 1, is4k: false },
      { id: 20, serverId: 2, is4k: true },
    ],
  }) as unknown as Media;
const server = (id: number, is4k = false): SonarrSettings =>
  ({
    id,
    is4k,
    isDefault: id === 0 || is4k,
    name: `Server ${id}`,
    hostname: `server${id}.test`,
    port: 8989,
    apiKey: 'test-key',
    useSsl: false,
  }) as SonarrSettings;
let appCounter = 1;
function app(
  permission = Permission.MANAGE_REQUESTS,
  userId = 1,
  validateApi = false
) {
  const app = express();
  const ip = `127.0.0.${appCounter++}`;
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: ip });
    req.user =
      permission === Permission.NONE
        ? undefined
        : new User({ id: userId, permissions: permission });
    next();
  });
  if (validateApi) {
    app.use(
      OpenApiValidator.middleware({
        apiSpec: nodePath.resolve('seerr-api.yml'),
        validateRequests: true,
      })
    );
    app.use('/api/v1/tv/:id/downloads', routes);
  } else {
    app.use('/tv/:id/downloads', routes);
  }
  app.use(((err, _req, res, next) => {
    void next;
    res.status(err.status ?? 500).json({ message: err.message });
  }) as ErrorRequestHandler);
  return app;
}
const path = '/tv/123/downloads';
let originalServers: SonarrSettings[];
beforeEach(() => {
  originalServers = getSettings().sonarr;
  getSettings().sonarr = [server(0), server(1), server(2, true)];
  mock.method(Media, 'getMedia', async () => media());
  mock.method(SonarrDownloadsAPI.prototype, 'downloadSeries', async () => [
    series,
  ]);
  mock.method(SonarrDownloadsAPI.prototype, 'downloadEpisodes', async () => [
    episode,
  ]);
  mock.method(SonarrDownloadsAPI.prototype, 'downloadQueue', async () => ({
    records: [],
    truncated: false,
  }));
  mock.method(SonarrDownloadsAPI.prototype, 'downloadHistory', async () => ({
    records: [],
    truncated: false,
  }));
  mock.method(SonarrDownloadsAPI.prototype, 'downloadReleases', async () => [
    release,
  ]);
});
afterEach(() => {
  mock.restoreAll();
  getSettings().sonarr = originalServers;
});

describe('TV download routes authorization and mapping', () => {
  it('denies ordinary users and anonymous users for all operations before upstream access', async () => {
    const lookup = mock.method(
      SonarrDownloadsAPI.prototype,
      'downloadSeries',
      async () => [series]
    );
    for (const permission of [Permission.NONE, Permission.REQUEST]) {
      const api = request(app(permission));
      assert.equal((await api.get(path)).status, 403);
      assert.equal(
        (await api.post(`${path}/search`).send(selection)).status,
        403
      );
      assert.equal(
        (await api.post(`${path}/grab`).send(selection)).status,
        403
      );
    }
    assert.equal(lookup.mock.callCount(), 0);
    assert.equal((await request(app(Permission.ADMIN)).get(path)).status, 200);
  });
  it('uses server zero and request-specific/4K mappings without user supplied servers', async () => {
    const hosts: string[] = [];
    mock.method(
      SonarrDownloadsAPI.prototype,
      'downloadSeries',
      async function (this: SonarrDownloadsAPI) {
        hosts.push(
          (this as unknown as { axios: AxiosInstance }).axios.defaults
            .baseURL ?? ''
        );
        return [series];
      }
    );
    const api = request(app());
    assert.equal((await api.get(path)).status, 200);
    assert.equal((await api.get(`${path}?requestId=10`)).status, 200);
    assert.equal((await api.get(`${path}?is4k=true&requestId=20`)).status, 200);
    assert.deepEqual(hosts, [
      'http://server0.test:8989/api/v3',
      'http://server1.test:8989/api/v3',
      'http://server2.test:8989/api/v3',
    ]);
    assert.equal((await api.get(`${path}?requestId=20`)).status, 404);
    assert.equal(
      (await api.post(`${path}/search`).send({ ...selection, serverId: 2 }))
        .status,
      400
    );
  });
  it('keeps media mappings for null/undefined request overrides but retains explicit server zero', async () => {
    mock.method(
      Media,
      'getMedia',
      async () =>
        ({
          ...media(),
          serviceId: 1,
          serviceId4k: 3,
          requests: [
            { id: 10, serverId: null, is4k: false },
            { id: 11, is4k: false },
            { id: 12, serverId: 0, is4k: false },
            { id: 20, serverId: null, is4k: true },
          ],
        }) as unknown as Media
    );
    getSettings().sonarr.push({ ...server(3, true), isDefault: false });
    const grab = mock.method(
      SonarrDownloadsAPI.prototype,
      'grabDownload',
      async () => {}
    );
    const api = request(app());
    for (const [requestId, is4k, expected] of [
      [10, false, 1],
      [11, false, 1],
      [12, false, 0],
      [20, true, 3],
    ] as const) {
      const diagnosis = await api.get(
        `${path}?requestId=${requestId}&is4k=${is4k}`
      );
      assert.equal(diagnosis.status, 200);
      assert.equal(diagnosis.body.serverName, `Server ${expected}`);
      const target = { ...selection, requestId, is4k };
      const result = await api.post(`${path}/search`).send(target);
      assert.equal(result.status, 200);
      assert.equal(
        (
          await api.post(`${path}/grab`).send({
            ...target,
            token: result.body.releases[0].token,
            confirmRejected: false,
            confirmDuplicate: false,
          })
        ).status,
        202
      );
    }
    assert.equal(grab.mock.callCount(), 4);
  });
  it('does not fall back when a specifically mapped server has disappeared', async () => {
    getSettings().sonarr = [server(1)];
    assert.equal((await request(app()).get(path)).status, 409);
  });
  it('rejects malformed identifiers and episodes or seasons from other series', async () => {
    const api = request(app());
    for (const id of ['0', '1x', '1.5', '9007199254740992'])
      assert.equal((await api.get(`/tv/${id}/downloads`)).status, 400);
    assert.equal((await api.get(`${path}?is4k=anything`)).status, 400);
    assert.equal(
      (await api.post(`${path}/search`).send({ ...selection, episodeId: 999 }))
        .status,
      400
    );
    assert.equal(
      (
        await api
          .post(`${path}/search`)
          .send({ ...selection, seasonNumber: 99 })
      ).status,
      400
    );
    assert.equal(
      (await api.post(`${path}/search`).send({ ...selection, episodeId: '21' }))
        .status,
      400
    );
  });
  it('returns safe errors rather than upstream credentials or payloads', async () => {
    mock.method(SonarrDownloadsAPI.prototype, 'downloadSeries', async () => {
      throw new Error('http://server.test?apikey=secret');
    });
    const response = await request(app()).get(path);
    assert.equal(response.status, 502);
    assert.ok(!response.text.includes('secret'));
    assert.ok(!response.text.includes('server.test'));
  });
  it('shows missing status without claiming rejected releases or no search results', async () => {
    const response = await request(app()).get(path);
    assert.equal(response.body.episodes[0].state, 'missing');
    assert.deepEqual(response.body.episodes[0].history, []);
    assert.ok(!('rejections' in response.body.episodes[0]));
  });
});
describe('TV release search and grab', () => {
  it('is reachable through the production OpenAPI validation middleware', async () => {
    const api = request(app(Permission.MANAGE_REQUESTS, 1, true));
    assert.equal(
      (
        await api
          .get('/api/v1/tv/123/downloads?is4k=false&requestId=10')
          .set('X-API-Key', 'test')
      ).status,
      200
    );
    const result = await api
      .post('/api/v1/tv/123/downloads/search')
      .set('X-API-Key', 'test')
      .send(selection);
    assert.equal(result.status, 200);
    mock.method(SonarrDownloadsAPI.prototype, 'grabDownload', async () => {});
    assert.equal(
      (
        await api
          .post('/api/v1/tv/123/downloads/grab')
          .set('X-API-Key', 'test')
          .send({
            ...selection,
            token: result.body.releases[0].token,
            confirmRejected: false,
            confirmDuplicate: false,
          })
      ).status,
      202
    );
    assert.equal(
      (
        await api
          .post('/api/v1/tv/123/downloads/search')
          .set('X-API-Key', 'test')
          .send({ ...selection, downloadUrl: 'arbitrary' })
      ).status,
      400
    );
  });
  it('allows only cached verified identities and consumes successful tokens once', async () => {
    const grab = mock.method(
      SonarrDownloadsAPI.prototype,
      'grabDownload',
      async (release: SonarrRelease) => {
        void release;
      }
    );
    const api = request(app());
    const search = await api.post(`${path}/search`).send(selection);
    assert.equal(search.status, 200);
    const token = search.body.releases[0].token;
    const payload = {
      ...selection,
      token,
      confirmRejected: false,
      confirmDuplicate: false,
    };
    assert.equal(
      (
        await api
          .post(`${path}/grab`)
          .send({ ...payload, downloadUrl: 'http://arbitrary.test' })
      ).status,
      400
    );
    assert.equal((await api.post(`${path}/grab`).send(payload)).status, 202);
    assert.equal((await api.post(`${path}/grab`).send(payload)).status, 409);
    assert.equal(grab.mock.callCount(), 1);
    assert.equal(grab.mock.calls[0].arguments[0].guid, 'cached-guid');
  });
  it('does not submit the same release twice under concurrent grabs', async () => {
    const grab = mock.method(
      SonarrDownloadsAPI.prototype,
      'grabDownload',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    );
    const api = request(app());
    const result = await api.post(`${path}/search`).send(selection);
    const payload = {
      ...selection,
      token: result.body.releases[0].token,
      confirmRejected: false,
      confirmDuplicate: false,
    };
    const responses = await Promise.all([
      api.post(`${path}/grab`).send(payload),
      api.post(`${path}/grab`).send(payload),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
    assert.equal(grab.mock.callCount(), 1);
  });
  it('rejects tokens across users and changed server configuration', async () => {
    const api = request(app());
    const search = await api.post(`${path}/search`).send(selection);
    const payload = {
      ...selection,
      token: search.body.releases[0].token,
      confirmRejected: false,
      confirmDuplicate: false,
    };
    assert.equal(
      (
        await request(app(Permission.MANAGE_REQUESTS, 2))
          .post(`${path}/grab`)
          .send(payload)
      ).status,
      403
    );
    getSettings().sonarr = [{ ...server(0), apiKey: 'changed' }];
    assert.equal((await api.post(`${path}/grab`).send(payload)).status, 403);
  });
  it('requires explicit rejection and duplicate confirmations including duplicates appearing after search', async () => {
    mock.method(SonarrDownloadsAPI.prototype, 'downloadReleases', async () => [
      { ...release, rejected: true, rejections: ['Quality not wanted'] },
    ]);
    const grab = mock.method(
      SonarrDownloadsAPI.prototype,
      'grabDownload',
      async (release: SonarrRelease) => {
        void release;
      }
    );
    const api = request(app());
    const search = await api.post(`${path}/search`).send(selection);
    const payload = {
      ...selection,
      token: search.body.releases[0].token,
      confirmRejected: false,
      confirmDuplicate: false,
    };
    assert.equal((await api.post(`${path}/grab`).send(payload)).status, 409);
    mock.method(SonarrDownloadsAPI.prototype, 'downloadEpisodes', async () => [
      { ...episode, hasFile: true },
    ]);
    assert.equal(
      (
        await api
          .post(`${path}/grab`)
          .send({ ...payload, confirmRejected: true })
      ).status,
      409
    );
    assert.equal(
      (
        await api
          .post(`${path}/grab`)
          .send({ ...payload, confirmRejected: true, confirmDuplicate: true })
      ).status,
      202
    );
    assert.equal(grab.mock.callCount(), 1);
  });
  it('shows unmapped results but never gives them a grab token or leaks private fields', async () => {
    mock.method(SonarrDownloadsAPI.prototype, 'downloadReleases', async () => [
      {
        ...release,
        mappedSeriesId: 999,
        downloadUrl: 'http://indexer.test?apikey=secret',
        rejections: ['Failure http://indexer.test?apikey=secret'],
      },
    ]);
    const response = await request(app())
      .post(`${path}/search`)
      .send(selection);
    assert.equal(response.status, 200);
    assert.equal(response.body.releases[0].token, undefined);
    assert.ok(!response.text.includes('secret'));
    assert.ok(!response.text.includes('downloadUrl'));
  });
  it('bounds results and prevents grabs with incomplete duplicate information', async () => {
    mock.method(SonarrDownloadsAPI.prototype, 'downloadReleases', async () =>
      Array.from({ length: 101 }, (_, i) => ({ ...release, guid: `id-${i}` }))
    );
    const api = request(app());
    const response = await api.post(`${path}/search`).send(selection);
    assert.equal(response.body.releases.length, 100);
    assert.equal(response.body.truncated, true);
    mock.method(SonarrDownloadsAPI.prototype, 'downloadQueue', async () => ({
      records: [],
      truncated: true,
    }));
    assert.equal(
      (
        await api.post(`${path}/grab`).send({
          ...selection,
          token: response.body.releases[0].token,
          confirmRejected: true,
          confirmDuplicate: true,
        })
      ).status,
      409
    );
    assert.equal(
      (await api.post(`${path}/search`).send(selection)).status,
      409
    );
  });
  it('consumes a token on uncertain failure so retry requires fresh progress and search', async () => {
    const grab = mock.method(
      SonarrDownloadsAPI.prototype,
      'grabDownload',
      async () => {
        throw new Error('Timeout secret');
      }
    );
    const api = request(app());
    const response = await api.post(`${path}/search`).send(selection);
    const payload = {
      ...selection,
      token: response.body.releases[0].token,
      confirmRejected: true,
      confirmDuplicate: true,
    };
    assert.equal((await api.post(`${path}/grab`).send(payload)).status, 502);
    assert.equal((await api.post(`${path}/grab`).send(payload)).status, 409);
    assert.equal(grab.mock.callCount(), 1);
  });
});
