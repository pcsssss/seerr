// Serve the production Next frontend with synthetic APIs only. Never start Seerr's
// server/index.ts, background jobs, database, or an upstream download client.
import type { NextServer, NextServerOptions } from 'next/dist/server/next.js';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import {
  mockDiagnostics,
  mockSearchForSelection,
  mockSettings,
  mockTv,
  mockUser,
} from './fixtures/tv-downloads.ts';

const port = 15056;
process.env.HOST = '127.0.0.1';
process.env.PORT = String(port);
Object.assign(process.env, { NODE_ENV: 'production' });
// Refuse all outbound server-side requests except this exact mock server.
for (const mod of [http, https]) {
  for (const method of ['request', 'get'] as const) {
    const original = mod[method];
    mod[method] = ((...args: unknown[]) => {
      const first = args[0];
      const url =
        typeof first === 'string' || first instanceof URL
          ? new URL(String(first))
          : undefined;
      const options = (url ? args[1] : first) as
        | { hostname?: string; host?: string; port?: number }
        | undefined;
      const hostname = url?.hostname ?? options?.hostname ?? options?.host;
      const targetPort = url?.port ?? options?.port;
      if (
        mod === https ||
        hostname !== '127.0.0.1' ||
        String(targetPort) !== String(port)
      ) {
        throw new Error('Mock TV server blocked an outbound request.');
      }
      return (original as (...args: unknown[]) => unknown)(...args);
    }) as typeof mod.request;
  }
}
const next = createRequire(import.meta.url)('next') as (
  options: NextServerOptions
) => Pick<NextServer, 'prepare' | 'getRequestHandler'>;
const app = next({ dev: false, hostname: '127.0.0.1', port });
await app.prepare();
const handler = app.getRequestHandler();
http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (!url.pathname.startsWith('/api/')) return handler(req, res);
    const ordinary = req.headers.cookie?.includes('mock-role=ordinary');
    switch (url.pathname) {
      case '/api/v1/auth/me':
        return send({ ...mockUser, permissions: ordinary ? 32 : 16 });
      case '/api/v1/settings/public':
        return send(mockSettings);
      case '/api/v1/status':
        return send({
          commitTag: 'local',
          version: 'mock',
          restartRequired: false,
        });
      case '/api/v1/request/count':
        return send({ pending: 0 });
      case '/api/v1/issue/count':
        return send({ open: 0 });
      case '/api/v1/tv/123':
        return send(mockTv);
      case '/api/v1/tv/123/ratings':
        return send({});
      case '/api/v1/tv/123/recommendations':
      case '/api/v1/tv/123/similar':
        return send({ results: [], totalResults: 0, totalPages: 0 });
      case '/api/v1/tv/123/downloads':
        return send(mockDiagnostics, ordinary ? 403 : 200);
      case '/api/v1/tv/123/downloads/search': {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        const selection = JSON.parse(body) as {
          seasonNumber: number;
          episodeId?: number;
        };
        return send(
          mockSearchForSelection(selection.seasonNumber, selection.episodeId),
          ordinary ? 403 : 200
        );
      }
      // Browser tests must intercept every mutation; even this mock fails closed.
      case '/api/v1/tv/123/downloads/grab':
        return send({ message: 'Browser must intercept mock grabs.' }, 500);
      default:
        return send({ message: 'Unknown synthetic API route.' }, 404);
    }
  })
  .listen(port, '127.0.0.1', () =>
    process.stdout.write(`Mock-only Next server http://127.0.0.1:${port}\n`)
  );
