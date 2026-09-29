// HTTP + WebSocket server with owner and read-only viewer capabilities.
//
// Two modes. Local (default, self-hosted): one session, owned by whoever opens the printed link.
// Hosted: every visitor gets their own session through a signed anonymous cookie, and listening is
// metered in credits (billing/credits.ts): a provider key is only minted against a reservation of
// the visitor's remaining time, and stopping or leaving settles it.
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
import type { CreditStore } from './billing/credits';
import type { SessionHub } from './billing/hub';
import type { VisitorIdentity } from './billing/identity';
import type { StripeBilling } from './billing/stripe';
import type { CreditView } from '../shared/contracts';

export type HostedOptions = {
  hub: SessionHub;
  credits: CreditStore;
  identity: VisitorIdentity;
  /** Public origin behind the reverse proxy, e.g. https://quran.example (adds its host/origin). */
  publicOrigin?: string;
  /** Take the client address from X-Forwarded-For (only behind a trusted proxy). */
  trustProxy?: boolean;
  /** Buying listening time (off unless Stripe keys are configured). */
  billing?: StripeBilling | null;
};

export type AppOptions = {
  /**
   * Serve under a path of another site (e.g. "/quran-reader" on nurra.org). Requests with or
   * without the prefix both work (a proxy may strip it or not); every address the browser is given
   * carries it.
   */
  basePath?: string;
  /** Extra Host names to accept, e.g. the origin name a proxy in front forwards to ("reader-origin.nurra.org"). */
  extraHosts?: string[];
  /** Local mode: the one session. Not used when `hosted` is set. */
  session?: Session;
  hosted?: HostedOptions;
  port: number;
  host?: string;
  sonioxApiKey?: string;
  devOrigins?: string[];
  ownerToken?: string;
  fetchImpl?: typeof fetch;
};

const COOKIE = 'qo_owner';

function formatPrice(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
const VISITOR_COOKIE = 'qo_visitor';
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

/** One limit per key (visitor or network) instead of one for the whole server. */
class KeyedRateLimit {
  private readonly limits = new Map<string, RateLimit>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(key: string, now = Date.now()) {
    if (this.limits.size > 50_000) this.limits.clear(); // bounded memory; a reset only relaxes limits
    let l = this.limits.get(key);
    if (!l) this.limits.set(key, (l = new RateLimit(this.max, this.windowMs)));
    return l.take(now);
  }
}

export async function buildApp(o: AppOptions): Promise<{ app: FastifyInstance; ownerToken: string }> {
  if (!o.session && !o.hosted) throw new Error('buildApp needs a session (local mode) or hosted options');
  const local = o.session as Session;
  const ownerToken = o.ownerToken ?? randomBytes(24).toString('base64url');
  const ownerCookie = randomBytes(24).toString('base64url');
  const host = o.host ?? '127.0.0.1';
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`, `[::1]:${o.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  for (const d of [...(o.devOrigins ?? []), ...(o.hosted?.publicOrigin ? [o.hosted.publicOrigin] : [])]) {
    allowedOrigins.add(d);
    allowedHosts.add(new URL(d).host);
  }
  for (const h of o.extraHosts ?? []) if (h.trim()) allowedHosts.add(h.trim().toLowerCase());
  const hosted = o.hosted ?? null;
  const secureCookie = !!hosted?.publicOrigin?.startsWith('https:');
  const visitorCookie = (value: string) => `${VISITOR_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secureCookie ? '; Secure' : ''}`;
  // Local: one owner. Hosted: per visitor, so one busy minute for others never refuses anyone's mic.
  const keyLimit = new RateLimit(10, 60_000);
  const visitorKeyLimit = new KeyedRateLimit(10, 60_000);
  // New anonymous identities per network: stops a script from flooding the server with sessions.
  const identityLimit = new KeyedRateLimit(30, 60 * 60_000);
  const checkoutLimit = new KeyedRateLimit(10, 10 * 60_000);
  const exchangeLimit = new RateLimit(20, 60_000);

  // Request logging stays off: URLs could carry capabilities in misconfigured clients.
  const base = normalizeBase(o.basePath);
  const app = Fastify({
    logger: false,
    bodyLimit: 16_384,
    rewriteUrl: base ? (req) => stripBase(req.url ?? '/', base) : undefined,
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: 256 * 1024 } });

  // JSON bodies keep their exact text: the payment webhook's signature covers the raw bytes.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, (body as string).length ? JSON.parse(body as string) : {});
    } catch (e) {
      (e as { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });
  const restoreLimit = new RateLimit(30, 60_000);

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
  /** Hosted: the visitor id from the signed cookie. */
  const visitor = (req: FastifyRequest) => (hosted ? hosted.identity.verify(readCookie(req, VISITOR_COOKIE)) : null);
  /** The session this request controls, if any (local: the owner's; hosted: the visitor's own). */
  const sessionFor = (req: FastifyRequest): Session | null => {
    if (!hosted) return isOwner(req) ? local : null;
    const id = visitor(req);
    return id ? hosted.hub.get(id) : null;
  };
  const clientIp = (req: FastifyRequest) => {
    const fwd = hosted?.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return fwd || req.ip || 'unknown';
  };
  const creditView = (id: string, ip: string): CreditView => {
    const c = hosted!.credits;
    const b = c.balance(id, ip);
    return { available: b.available + b.reserved - c.openUsage(id).usedSeconds, free: b.free, paid: b.paid, sponsored: b.sponsored, pool: b.pool, freeUsedThisMonth: b.freeUsedThisMonth, freePerMonth: b.freePerMonth, freePerDay: c.cfg.ipDailyFreeSeconds, sharePerDay: b.sharePerDay, limitedBy: b.limitedBy, renewsAt: b.renewsAt, listeningSeconds: c.openUsage(id).usedSeconds };
  };
  /** Last known address per visitor (for pushing balances from the periodic sweep). */
  const lastIp = new Map<string, string>();
  const pushCredits = (id: string) => {
    const s = hosted?.hub.peek(id);
    if (s) s.notify({ type: 'credits', credits: creditView(id, lastIp.get(id) ?? 'unknown') });
  };
  const requireOwner = (req: FastifyRequest, reply: FastifyReply) => {
    if (!originOk(req)) {
      reply.code(403).send({ error: 'origin' });
      return false;
    }
    if (!sessionFor(req)) {
      reply.code(401).send({ error: 'owner' });
      return false;
    }
    return true;
  };

  // Liveness for a process manager or load balancer (no data).
  app.get('/healthz', async () => ({ ok: true }));

  // Who am I: local mode reports ownership; hosted mode issues the visitor cookie on first visit.
  app.get('/api/me', async (req, reply) => {
    if (!hosted) return { mode: 'local', owner: isOwner(req) };
    let id = visitor(req);
    let cookieValue = readCookie(req, VISITOR_COOKIE);
    if (!id) {
      if (!identityLimit.take(clientIp(req))) return reply.code(429).send({ error: 'Too many new visitors from this network. Please try again later.' });
      const v = hosted.identity.issue();
      id = v.id;
      cookieValue = v.cookie;
      reply.header('Set-Cookie', visitorCookie(v.cookie));
    }
    lastIp.set(id, clientIp(req));
    return {
      mode: 'hosted',
      owner: true,
      credits: creditView(id, clientIp(req)),
      // The visitor's own code to keep their time on another device or after clearing cookies.
      recoveryCode: cookieValue,
      // Sponsored listening so far (totals only; nothing about who gave or who recited).
      sponsored: hosted.credits.poolStats(),
      billing: hosted.billing
        ? {
            packs: hosted.billing.packs.map((p) => ({ id: p.id, hours: p.hours, label: p.label, price: formatPrice(p.amountCents, p.currency) })),
            donations: hosted.billing.donations.amountsCents.map((c) => ({ amountCents: c, price: formatPrice(c, hosted.billing!.donations.currency), hours: hosted.billing!.sponsoredHours(c) })),
          }
        : null,
    };
  });

  // The shared pool's live story (the community bar polls it). Totals only.
  app.get('/api/pool', async (_req, reply) => {
    if (!hosted) return reply.code(404).send({ error: 'not available' });
    return hosted.credits.poolStats();
  });

  // Restore a visitor identity from its recovery code (another device, cleared cookies).
  app.post('/api/me/restore', async (req, reply) => {
    if (!hosted) return reply.code(404).send({ error: 'not available' });
    if (!originOk(req)) return reply.code(403).send({ error: 'origin' });
    if (!restoreLimit.take()) return reply.code(429).send({ error: 'rate' });
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? '').trim();
    const id = hosted.identity.verify(code);
    if (!id) return reply.code(400).send({ error: 'That code is not valid.' });
    reply.header('Set-Cookie', visitorCookie(code));
    return { ok: true };
  });

  // Buy listening time: a Stripe-hosted checkout page for one pack.
  app.post('/api/billing/checkout', async (req, reply) => {
    if (!hosted?.billing) return reply.code(404).send({ error: 'not available' });
    if (!originOk(req)) return reply.code(403).send({ error: 'origin' });
    const id = visitor(req);
    if (!id) return reply.code(401).send({ error: 'visitor' });
    if (!checkoutLimit.take(id)) return reply.code(429).send({ error: 'Please wait a moment before trying again.' });
    const pack = hosted.billing.pack(String((req.body as { pack?: unknown } | undefined)?.pack ?? ''));
    if (!pack) return reply.code(400).send({ error: 'unknown pack' });
    try {
      return { url: await hosted.billing.checkout(id, pack, `${hosted.publicOrigin ?? `http://${req.headers.host}`}${base}`) };
    } catch {
      return reply.code(502).send({ error: 'The payment page could not be opened. Please try again.' });
    }
  });

  // Sponsor listening for others: a Stripe-hosted checkout for a donation to the shared pool.
  app.post('/api/billing/donate', async (req, reply) => {
    if (!hosted?.billing) return reply.code(404).send({ error: 'not available' });
    if (!originOk(req)) return reply.code(403).send({ error: 'origin' });
    const id = visitor(req);
    if (!id) return reply.code(401).send({ error: 'visitor' });
    if (!checkoutLimit.take(id)) return reply.code(429).send({ error: 'Please wait a moment before trying again.' });
    const amount = Number((req.body as { amountCents?: unknown } | undefined)?.amountCents);
    if (!hosted.billing.donations.amountsCents.includes(amount)) return reply.code(400).send({ error: 'unknown amount' });
    try {
      return { url: await hosted.billing.checkoutDonation(id, amount, `${hosted.publicOrigin ?? `http://${req.headers.host}`}${base}`) };
    } catch {
      return reply.code(502).send({ error: 'The payment page could not be opened. Please try again.' });
    }
  });

  // Stripe's signed notification that a payment succeeded: grant the pack once (or fill the pool).
  app.post('/api/billing/webhook', { bodyLimit: 1_048_576 }, async (req, reply) => {
    if (!hosted?.billing) return reply.code(404).send({ error: 'not available' });
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const event = hosted.billing.verify(raw, req.headers['stripe-signature'] as string | undefined);
    if (!event) return reply.code(400).send({ error: 'signature' });
    const p = hosted.billing.purchase(event);
    if (p && hosted.credits.grant(p.visitorId, p.pack.hours * 3600, `stripe ${p.pack.id}`, Date.now(), `stripe:${p.paymentId}`)) pushCredits(p.visitorId);
    const g = hosted.billing.gift(event);
    if (g) hosted.credits.grantPool(g.seconds, `stripe:${g.paymentId}`, g.amountCents, g.currency);
    return { received: true };
  });

  app.post('/api/owner/session', async (req, reply) => {
    if (hosted) return reply.code(404).send({ error: 'not available' });
    if (!originOk(req)) return reply.code(403).send({ error: 'origin' });
    if (!exchangeLimit.take()) return reply.code(429).send({ error: 'rate' });
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !safeEqual(token, ownerToken)) return reply.code(401).send({ error: 'invalid owner link' });
    reply.header('Set-Cookie', `${COOKIE}=${ownerCookie}; HttpOnly; SameSite=Strict; Path=/`);
    return { ok: true };
  });

  app.get('/api/owner/status', async (req) => ({ owner: !!sessionFor(req) }));

  app.post('/api/soniox/temporary-key', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    if (hosted ? !visitorKeyLimit.take(visitor(req)!) : !keyLimit.take()) return reply.code(429).send({ error: 'RATE_LIMITED' });
    if (!hosted) {
      try {
        const key = await mintTemporaryKey(o.sonioxApiKey, `quran-overlay:${local.sessionEpoch}`, o.fetchImpl);
        return key;
      } catch (e) {
        const code = e instanceof SonioxKeyError ? e.code : 'REQUEST_REJECTED';
        return reply.code(code === 'NOT_CONFIGURED' ? 503 : 502).send({ error: code });
      }
    }
    // Hosted: the key's hard maximum duration is a reservation of the visitor's remaining time.
    const id = visitor(req)!;
    const ip = clientIp(req);
    lastIp.set(id, ip);
    const hold = hosted.credits.reserve(id, ip);
    if ('error' in hold) {
      pushCredits(id);
      return reply.code(402).send({ error: 'NO_CREDITS', limitedBy: hold.balance.limitedBy, renewsAt: hold.balance.renewsAt });
    }
    try {
      const key = await mintTemporaryKey(o.sonioxApiKey, `quran-overlay:${id}`, o.fetchImpl, hold.maxSeconds);
      pushCredits(id);
      return key;
    } catch (e) {
      hosted.credits.release(hold.id);
      const code = e instanceof SonioxKeyError ? e.code : 'REQUEST_REJECTED';
      return reply.code(code === 'NOT_CONFIGURED' ? 503 : 502).send({ error: code });
    }
  });

  app.get('/api/chapters', async (req, reply) => {
    const s = sessionFor(req);
    if (!s) return reply.code(401).send({ error: 'owner' });
    return s.chapters();
  });

  app.get('/api/verse/:key', async (req, reply) => {
    const session = sessionFor(req);
    if (!session) return reply.code(401).send({ error: 'owner' });
    const card = session.card((req.params as { key: string }).key);
    return card ?? reply.code(404).send({ error: 'not found' });
  });

  app.get('/api/surah/:n', async (req, reply) => {
    const session = sessionFor(req);
    if (!session) return reply.code(401).send({ error: 'owner' });
    const s = session.surah(Number((req.params as { n: string }).n));
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
    const found = originOk(req) ? sessionFor(req) : null;
    if (!found) {
      socket.close(4401, 'owner required');
      return;
    }
    const s = found;
    const visitorId = visitor(req);
    if (visitorId) lastIp.set(visitorId, clientIp(req));
    const send = (m: ControlServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const off = s.onControl(send);
    s.controlConnected();
    send({ type: 'snapshot', snapshot: s.snapshot() });
    if (visitorId) send({ type: 'credits', credits: creditView(visitorId, clientIp(req)) });
    socket.on('message', (raw) => {
      let parsed;
      try {
        parsed = ControlClientMessageSchema.safeParse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (!parsed.success) return;
      s.handle(parsed.data);
      // A stream that ended is charged for the time it actually ran.
      if (visitorId && parsed.data.type === 'capture' && (parsed.data.event === 'stopped' || parsed.data.event === 'dozing' || parsed.data.event === 'error')) {
        hosted!.credits.settle(visitorId);
        pushCredits(visitorId);
      }
    });
    socket.on('close', () => {
      off();
      s.controlDisconnected();
      // The last page closed: whatever it was streaming has ended (a client that keeps streaming
      // anyway is still limited by its key's maximum duration).
      if (visitorId && s.controlCount === 0) hosted!.credits.settle(visitorId);
    });
  });

  // ---------- overlay WebSocket (read-only) ----------
  app.get('/ws/overlay', { websocket: true }, (socket, req) => {
    if (!originOk(req)) {
      socket.close(4403, 'origin');
      return;
    }
    let s: Session = local;
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
        const target = m.role === 'preview' ? sessionFor(req) : hosted ? hosted.hub.byView(m.view) : local.checkView(m.view) ? local : null;
        if (!target) {
          send({ type: 'denied', reason: 'invalid_view' });
          socket.close(4401, 'invalid view');
          return;
        }
        s = target;
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
    // Link previews need an absolute image address: the public origin, when there is one.
    const origin = hosted?.publicOrigin?.replace(/\/+$/, '');
    const indexHtml = () => {
      let html = readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
      if (origin) {
        html = html
          .replace(/content="\.?\/og\.png"/, `content="${origin}${base}/og.png"`)
          .replace('<meta property="og:type"', `<meta property="og:url" content="${origin}${base}/" /><meta property="og:type"`);
      }
      // Every page, script, font and icon address under the base path; the page learns it too.
      return html
        .replace(/(href|src|content)="\.?\//g, (_m, attr: string) => `${attr}="${base}/`)
        .replace(/url\((['"]?)\/fonts\//g, (_m, q: string) => `url(${q}${base}/fonts/`)
        .replace('<head>', `<head>\n    <meta name="qo-base" content="${base}" />`);
    };
    for (const route of ['/control', '/overlay', '/read', '/reader', '/about']) app.get(route, (_req, reply) => reply.type('text/html').send(indexHtml()));
    app.get('/', (_req, reply) => (hosted ? reply.type('text/html').send(indexHtml()) : reply.redirect(`${base}/control`)));
    // The installable app's manifest, with its start page and icons under the base path.
    app.get('/manifest.webmanifest', (_req, reply) =>
      reply.type('application/manifest+json').send(readFileSync(path.join(WEB_DIST, 'manifest.webmanifest'), 'utf8').replace(/": "\//g, `": "${base}/`)),
    );
  } else {
    app.get('/', (_req, reply) => reply.type('text/plain').send('Frontend not built. Run `npm run build`, or use `npm run dev`.'));
  }

  if (hosted) {
    // Expired holds (streams the provider has cut) are charged; idle sessions are released.
    const sweep = setInterval(() => {
      for (const id of hosted.credits.usersWithOpenHolds()) {
        if (hosted.credits.settleExpired(id) > 0) pushCredits(id);
        else if (hosted.hub.peek(id)?.listening) pushCredits(id);
      }
      hosted.hub.sweep();
    }, 10_000);
    sweep.unref?.();
    app.addHook('onClose', async () => clearInterval(sweep));
  }

  return { app, ownerToken };
}

/** "/quran-reader" from "quran-reader/", "/quran-reader" or "" (no base). */
export function normalizeBase(p: string | undefined): string {
  const t = (p ?? '').trim().replace(/^\/*/, '/').replace(/\/+$/, '');
  return t === '/' ? '' : t;
}

/** The app's own path for a request that may or may not carry the base prefix. */
export function stripBase(url: string, base: string): string {
  if (!base) return url;
  if (url === base) return '/';
  if (url.startsWith(`${base}/`) || url.startsWith(`${base}?`) || url.startsWith(`${base}#`)) {
    const rest = url.slice(base.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return url;
}
