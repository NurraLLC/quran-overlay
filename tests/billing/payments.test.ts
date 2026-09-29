// Buying listening time (Stripe Checkout, mocked) and keeping it across devices (recovery code).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app';
import { CreditStore } from '../../src/server/billing/credits';
import { SessionHub } from '../../src/server/billing/hub';
import { VisitorIdentity } from '../../src/server/billing/identity';
import { signForTest, StripeBilling } from '../../src/server/billing/stripe';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import type { CreditView } from '../../src/shared/contracts';
import { fullCorpus } from '../helpers';

const WEBHOOK = 'whsec_test_0123456789';
let app: FastifyInstance;
let base = '';
let origin = '';
let credits: CreditStore;
const stripeCalls: Array<{ url: string; body: URLSearchParams }> = [];

beforeAll(async () => {
  const { corpus, ix } = fullCorpus();
  const resolver = new CommandResolver(corpus, null, null);
  credits = new CreditStore(':memory:', { freeSecondsPerMonth: 600, ipDailyFreeSeconds: 3600, globalDailyFreeSeconds: 36000, holdMaxSeconds: 300, holdMinSeconds: 20 });
  const hub = new SessionHub(
    () =>
      new Session({ corpus, ix, resolver, decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => 'unavailable' }, overlayUrl: (v) => `${origin}/overlay#view=${v}` }),
  );
  const stripeFetch = (async (url: string, init: RequestInit) => {
    stripeCalls.push({ url, body: new URLSearchParams(String(init.body)) });
    return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 });
  }) as unknown as typeof fetch;
  const billing = new StripeBilling('sk_test_x', WEBHOOK, [{ id: 'h20', hours: 20, amountCents: 300, currency: 'usd', label: '20 hours of listening' }], stripeFetch);
  const port = 45170 + Math.floor(Math.random() * 500);
  ({ app } = await buildApp({ port, sonioxApiKey: 'k', hosted: { hub, credits, identity: new VisitorIdentity(Buffer.alloc(48, 9)), billing } }));
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
  origin = base;
});
afterAll(async () => {
  await app?.close();
  await new Promise((r) => setTimeout(r, 200));
  credits?.close();
});

type Me = { credits: CreditView; recoveryCode: string; billing: { packs: Array<{ id: string; price: string }> } | null };
async function me(cookie?: string): Promise<{ cookie: string; body: Me }> {
  const r = await fetch(`${base}/api/me`, { headers: { origin, ...(cookie ? { cookie } : {}) } });
  return { cookie: cookie ?? r.headers.get('set-cookie')!.split(';')[0], body: (await r.json()) as Me };
}
const paidEvent = (visitor: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', payment_status: 'paid', client_reference_id: visitor, metadata: { visitor, pack: 'h20' }, amount_total: 300, currency: 'usd', ...over } },
  });
const webhook = (payload: string, sig = signForTest(payload, WEBHOOK)) => fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });

describe('buying listening time', () => {
  it('offers the packs and opens a Stripe checkout carrying the visitor and pack', async () => {
    const v = await me();
    expect(v.body.billing?.packs).toEqual([{ id: 'h20', hours: 20, label: '20 hours of listening', price: '$3.00' }]);
    const r = await fetch(`${base}/api/billing/checkout`, { method: 'POST', headers: { origin, cookie: v.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ pack: 'h20' }) });
    expect(await r.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const call = stripeCalls.at(-1)!;
    expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const visitorId = v.cookie.split('=')[1].split('.')[0];
    expect(call.body.get('metadata[visitor]')).toBe(visitorId);
    expect(call.body.get('metadata[pack]')).toBe('h20');
    expect(call.body.get('line_items[0][price_data][unit_amount]')).toBe('300');
  });

  it('grants the hours once for a signed paid checkout, and nothing for forged, unpaid or wrong-amount events', async () => {
    const v = await me();
    const id = v.cookie.split('=')[1].split('.')[0];
    expect((await webhook(paidEvent(id), 't=1,v1=forged')).status).toBe(400);
    expect((await webhook(paidEvent(id, { payment_status: 'unpaid', id: 'cs_unpaid' }))).status).toBe(200);
    expect((await webhook(paidEvent(id, { amount_total: 1, id: 'cs_cheap' }))).status).toBe(200);
    expect((await me(v.cookie)).body.credits.paid).toBe(0);
    expect((await webhook(paidEvent(id))).status).toBe(200);
    expect((await webhook(paidEvent(id))).status).toBe(200); // Stripe retries deliver the same payment again
    const after = (await me(v.cookie)).body.credits;
    expect(after.paid).toBe(20 * 3600);
    expect(after.available).toBe(600 + 20 * 3600);
  });

  it('keeps bought time on another device with the recovery code, and rejects made-up codes', async () => {
    const v = await me();
    const code = v.body.recoveryCode;
    const bad = await fetch(`${base}/api/me/restore`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'abcdefghijklmnopqrstuv.nope' }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/api/me/restore`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect(ok.status).toBe(200);
    const restoredCookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect(restoredCookie).toBe(v.cookie);
  });
});
