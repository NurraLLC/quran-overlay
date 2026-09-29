// Loopback HTTP + WebSocket server with owner and read-only viewer capabilities.
//
// Owner: a random capability printed by the launcher (/control#owner=…) is exchanged for an
// HttpOnly SameSite=Strict cookie. Only the owner can mint provider keys, change position or see
// transcripts. Viewer: a separate revocable token in /overlay#view=…, sent in the first WS frame
// (never in a URL the server logs). Exact Host/Origin checks; no wildcard CORS.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  ControlClientMessageSchema,
  OverlayClientMessageSchema,
  type ControlServerMessage,
  type OverlayServerMessage,
} from '../shared/contracts';
import { PROCESSED_FONT_DIR, ROOT } from './corpus/manifest';
import { mintTemporaryKey, SonioxKeyError } from './providers/soniox';
import type { Session } from './sessions';

export type AppOptions = {
  session: Session;
  port: number;
  host?: string;
  sonioxApiKey?: string;
  devOrigins?: string[];
  ownerToken?: string;
  fetchImpl?: typeof fetch;
};

const COOKIE = 'qo_owner';
const WEB_DIST = path.join(ROOT, 'dist', 'web');

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

class RateLimit {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(now = Date.now()) {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

export async function buildApp(o: AppOptions): Promise<{ app: FastifyInstance; ownerToken: string }> {
  const ownerToken = o.ownerToken ?? randomBytes(24).toString('base64url');
  const ownerCookie = randomBytes(24).toString('base64url');
  const host = o.host ?? '127.0.0.1';
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`, `[::1]:${o.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  for (const d of o.devOrigins ?? []) {
    allowedOrigins.add(d);
    allowedHosts.add(new URL(d).host);
  }
  const keyLimit = new RateLimit(10, 60_000);
  const exchangeLimit = new RateLimit(20, 60_000);

  // Request logging stays off: URLs could carry capabilities in misconfigured clients.
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  await app.register(fastifyWebsocket, { options: { maxPayload: 256 * 1024 } });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.headers.host || !allowedHosts.has(req.headers.host)) return reply.code(421).send({ error: 'unexpected host' });
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });

  const originOk = (req: FastifyRequest) => {
    const origin = req.headers.origin;
    return !!origin && allowedOrigins.has(origin);
  };
  const isOwner = (req: FastifyRequest) => {
    const c = readCookie(req, COOKIE);
    return !!c && safeEqual(c, ownerCookie);
  };
  const requireOwner = (req: FastifyRequest, reply: FastifyReply) => {
    if (!originOk(req)) {
      reply.code(403).send({ error: 'origin' });
      return false;
    }
    if (!isOwner(req)) {
      reply.code(401).send({ error: 'owner' });
      return false;
    }
    return true;
  };

  app.post('/api/owner/session', async (req, reply) => {
    if (!originOk(req)) return reply.code(403).send({ error: 'origin' });
    if (!exchangeLimit.take()) return reply.code(429).send({ error: 'rate' });
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !safeEqual(token, ownerToken)) return reply.code(401).send({ error: 'invalid owner link' });
    reply.header('Set-Cookie', `${COOKIE}=${ownerCookie}; HttpOnly; SameSite=Strict; Path=/`);
    return { ok: true };
  });

  app.get('/api/owner/status', async (req) => ({ owner: isOwner(req) }));

  app.post('/api/soniox/temporary-key', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    if (!keyLimit.take()) return reply.code(429).send({ error: 'RATE_LIMITED' });
    try {
      const key = await mintTemporaryKey(o.sonioxApiKey, `quran-overlay:${o.session.sessionEpoch}`, o.fetchImpl);
      return key;
    } catch (e) {
      const code = e instanceof SonioxKeyError ? e.code : 'REQUEST_REJECTED';
      return reply.code(code === 'NOT_CONFIGURED' ? 503 : 502).send({ error: code });
    }
  });

  app.get('/api/chapters', async (req, reply) => {
    if (!isOwner(req)) return reply.code(401).send({ error: 'owner' });
    return o.session.chapters();
  });

  app.get('/api/verse/:key', async (req, reply) => {
    if (!isOwner(req)) return reply.code(401).send({ error: 'owner' });
    const card = o.session.card((req.params as { key: string }).key);
    return card ?? reply.code(404).send({ error: 'not found' });
  });

  app.get('/api/surah/:n', async (req, reply) => {
    if (!isOwner(req)) return reply.code(401).send({ error: 'owner' });
    const s = o.session.surah(Number((req.params as { n: string }).n));
    return s ?? reply.code(404).send({ error: 'not found' });
  });

  app.get('/fonts/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[A-Za-z0-9_.-]+\.(ttf|otf|woff2?)$/.test(file)) return reply.code(404).send();
    const full = path.join(PROCESSED_FONT_DIR, file);
    if (!existsSync(full)) return reply.code(404).send();
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.type('font/ttf').send(readFileSync(full));
  });

  // ---------- control WebSocket ----------
  app.get('/ws/control', { websocket: true }, (socket, req) => {
    if (!originOk(req) || !isOwner(req)) {
      socket.close(4401, 'owner required');
      return;
    }
    const s = o.session;
    const send = (m: ControlServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const off = s.onControl(send);
    s.controlConnected();
    send({ type: 'snapshot', snapshot: s.snapshot() });
    socket.on('message', (raw) => {
      let parsed;
      try {
        parsed = ControlClientMessageSchema.safeParse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (parsed.success) s.handle(parsed.data);
    });
    socket.on('close', () => {
      off();
      s.controlDisconnected();
    });
  });

  // ---------- overlay WebSocket (read-only) ----------
  app.get('/ws/overlay', { websocket: true }, (socket, req) => {
    if (!originOk(req)) {
      socket.close(4403, 'origin');
      return;
    }
    const s = o.session;
    let off: (() => void) | null = null;
    let offRevoke: (() => void) | null = null;
    let role: 'overlay' | 'preview' = 'overlay';
    const send = (m: OverlayServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const authTimer = setTimeout(() => socket.close(4401, 'auth timeout'), 5000);
    socket.on('message', (raw) => {
      let parsed;
      try {
        parsed = OverlayClientMessageSchema.safeParse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const m = parsed.data;
      if (m.type === 'hello') {
        if (off) return;
        clearTimeout(authTimer);
        // The owner's own preview may subscribe with its cookie instead of the view token.
        const ok = m.role === 'preview' ? isOwner(req) : s.checkView(m.view);
        if (!ok) {
          send({ type: 'denied', reason: 'invalid_view' });
          socket.close(4401, 'invalid view');
          return;
        }
        role = m.role;
        if (role === 'overlay') s.overlayClients++;
        off = s.onDisplay((state) => send({ type: 'display', state }));
        const revoke = () => {
          if (role !== 'overlay') return;
          send({ type: 'denied', reason: 'revoked' });
          socket.close(4401, 'revoked');
        };
        s.revokeListeners.add(revoke);
        offRevoke = () => s.revokeListeners.delete(revoke);
        // Full latest state immediately on (re)connect.
        send({ type: 'display', state: s.display });
      } else if (m.type === 'painted' && off && role === 'overlay') {
        s.painted(m.revision);
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (off) {
        off();
        if (role === 'overlay') s.overlayClients = Math.max(0, s.overlayClients - 1);
      }
      offRevoke?.();
    });
  });

  // ---------- web app ----------
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/', index: false, wildcard: true });
    const indexHtml = () => readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
    for (const route of ['/control', '/overlay', '/read', '/reader']) app.get(route, (_req, reply) => reply.type('text/html').send(indexHtml()));
    app.get('/', (_req, reply) => reply.redirect('/control'));
  } else {
    app.get('/', (_req, reply) => reply.type('text/plain').send('Frontend not built. Run `npm run build`, or use `npm run dev`.'));
  }

  return { app, ownerToken };
}
