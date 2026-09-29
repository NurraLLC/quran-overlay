// Buying listening time with Stripe Checkout (hosted mode). Plain HTTPS to Stripe's REST API, no
// SDK. Nothing here runs unless STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set.
//
// Flow: the page asks for a pack -> we create a Checkout Session carrying the visitor id and pack in
// its metadata -> Stripe hosts the payment -> Stripe calls our webhook (signed) -> on a paid
// checkout.session.completed we grant the pack's hours once (the session id makes it idempotent).
// Only listening time is sold; reading, search and everything about the Quran text stay free.
// Donations ("sponsor listening for others") use the same flow and fill the shared sponsored pool.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type Pack = { id: string; hours: number; amountCents: number; currency: string; label: string };

/**
 * Default packs; override with QO_PACKS (JSON array of Pack). Prices are the owner's decision.
 * Listening costs about $0.12 per streamed hour, so these keep a margin that pays for free listening:
 * $5 for 20 h leaves about $2.35 after the provider and Stripe's fee.
 */
export const DEFAULT_PACKS: Pack[] = [
  { id: 'h20', hours: 20, amountCents: 500, currency: 'usd', label: '20 hours of listening' },
  { id: 'h60', hours: 60, amountCents: 1200, currency: 'usd', label: '60 hours of listening' },
];

/** Donation amounts and what each adds to the sponsored pool. */
export type Donations = { amountsCents: number[]; currency: string; centsPerHour: number };

/**
 * Default: $5, $10, $25. Each dollar adds listening at cost with Stripe's fee covered: 13 cents per
 * hour ($0.12 streamed hour plus the fee), so $10 gives about 76 hours. Override with QO_DONATIONS
 * (JSON array of cents) and QO_SPONSOR_CENTS_PER_HOUR.
 */
export const DEFAULT_DONATIONS: Donations = { amountsCents: [500, 1000, 2500], currency: 'usd', centsPerHour: 13 };

export function parseDonations(amounts: string | undefined, centsPerHour: string | undefined): Donations {
  const list = amounts ? (JSON.parse(amounts) as unknown) : DEFAULT_DONATIONS.amountsCents;
  if (!Array.isArray(list) || !list.length || !list.every((c) => Number.isInteger(c) && c >= 100 && c <= 100_000)) throw new Error('QO_DONATIONS must be a JSON array of amounts in cents (100 to 100000)');
  const cph = centsPerHour ? Number(centsPerHour) : DEFAULT_DONATIONS.centsPerHour;
  if (!Number.isFinite(cph) || cph < 1) throw new Error('QO_SPONSOR_CENTS_PER_HOUR must be a positive number');
  return { amountsCents: list as number[], currency: DEFAULT_DONATIONS.currency, centsPerHour: cph };
}

/** Packs to sell: none unless QO_PACKS lists some (listening is free, funded by the shared pool). */
export function parsePacks(json: string | undefined): Pack[] {
  if (!json) return [];
  const raw = JSON.parse(json) as Pack[];
  if (!Array.isArray(raw) || !raw.every((p) => /^[a-z0-9_-]{1,32}$/.test(p.id) && p.hours > 0 && p.amountCents >= 50 && /^[a-z]{3}$/.test(p.currency) && p.label)) throw new Error('QO_PACKS must be a JSON array of {id, hours, amountCents, currency, label}');
  return raw;
}

export class StripeBilling {
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    readonly packs: Pack[] = DEFAULT_PACKS,
    private readonly fetchImpl: typeof fetch = fetch,
    readonly donations: Donations = DEFAULT_DONATIONS,
  ) {}

  /** Hours of listening a donation adds to the sponsored pool. */
  sponsoredHours(amountCents: number): number {
    return Math.floor(amountCents / this.donations.centsPerHour);
  }

  /** A Stripe-hosted checkout page for a donation to the sponsored pool; returns its URL. */
  async checkoutDonation(visitorId: string, amountCents: number, origin: string): Promise<string> {
    if (!this.donations.amountsCents.includes(amountCents)) throw new Error('unknown amount');
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: `${origin}/?donated=1`,
      cancel_url: `${origin}/?canceled=1`,
      client_reference_id: visitorId,
      'metadata[kind]': 'donation',
      'metadata[amount]': String(amountCents),
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': this.donations.currency,
      'line_items[0][price_data][unit_amount]': String(amountCents),
      'line_items[0][price_data][product_data][name]': 'Sponsor listening for others',
      'line_items[0][price_data][product_data][description]': `Adds about ${this.sponsoredHours(amountCents)} hours of live recitation listening to the shared pool for people whose free time has run out.`,
    });
    return this.createSession(form);
  }

  /** What a verified event gives the sponsored pool, if it is a paid donation of an offered amount. */
  gift(event: StripeEvent): { amountCents: number; currency: string; seconds: number; paymentId: string } | null {
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return null;
    const s = event.data?.object;
    if (!s || s.payment_status !== 'paid' || s.metadata?.kind !== 'donation' || !s.id) return null;
    const amount = Number(s.metadata.amount);
    if (!this.donations.amountsCents.includes(amount)) return null;
    // What was paid must be what was offered (a tampered or stale session adds nothing).
    if (s.amount_total !== amount || s.currency !== this.donations.currency) return null;
    return { amountCents: amount, currency: this.donations.currency, seconds: this.sponsoredHours(amount) * 3600, paymentId: s.id };
  }

  private async createSession(form: URLSearchParams): Promise<string> {
    const res = await this.fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
    if (!res.ok || !body.url) throw new Error(body.error?.message ?? `Stripe checkout failed (${res.status})`);
    return body.url;
  }

  pack(id: string): Pack | undefined {
    return this.packs.find((p) => p.id === id);
  }

  /** A Stripe-hosted checkout page for one pack; returns its URL. */
  async checkout(visitorId: string, pack: Pack, origin: string): Promise<string> {
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: `${origin}/?paid=${pack.id}`,
      cancel_url: `${origin}/?canceled=1`,
      client_reference_id: visitorId,
      'metadata[visitor]': visitorId,
      'metadata[pack]': pack.id,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': pack.currency,
      'line_items[0][price_data][unit_amount]': String(pack.amountCents),
      'line_items[0][price_data][product_data][name]': pack.label,
      'line_items[0][price_data][product_data][description]': 'Live recitation listening time for Quran Overlay. Reading and search are always free.',
    });
    return this.createSession(form);
  }

  /**
   * The event in a webhook delivery, if its Stripe-Signature is valid and recent (Stripe's scheme:
   * HMAC-SHA256 of "timestamp.payload" with the endpoint secret; 5-minute tolerance).
   */
  verify(payload: string, signatureHeader: string | undefined, now = Date.now()): StripeEvent | null {
    if (!signatureHeader) return null;
    const parts = signatureHeader.split(',').map((p) => p.trim().split('='));
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
    if (!Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > 300) return null;
    const want = Buffer.from(createHmac('sha256', this.webhookSecret).update(`${t}.${payload}`).digest('hex'));
    if (!sigs.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), want))) return null;
    try {
      return JSON.parse(payload) as StripeEvent;
    } catch {
      return null;
    }
  }

  /** What a verified event grants, if anything: a paid checkout for one of our packs. */
  purchase(event: StripeEvent): { visitorId: string; pack: Pack; paymentId: string } | null {
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return null;
    const s = event.data?.object;
    if (!s || s.payment_status !== 'paid' || s.metadata?.kind === 'donation') return null;
    const pack = this.pack(s.metadata?.pack ?? '');
    const visitorId = s.metadata?.visitor ?? s.client_reference_id;
    if (!pack || !visitorId || !s.id) return null;
    // Amount and currency must be what the pack costs (a tampered or stale session grants nothing).
    if (s.amount_total !== undefined && (s.amount_total !== pack.amountCents || s.currency !== pack.currency)) return null;
    return { visitorId, pack, paymentId: s.id };
  }
}

export type StripeEvent = {
  id: string;
  type: string;
  data?: {
    object?: {
      id?: string;
      payment_status?: string;
      client_reference_id?: string | null;
      metadata?: Record<string, string>;
      amount_total?: number;
      currency?: string;
    };
  };
};

/** Test helper and documentation: the header Stripe would send for this payload. */
export function signForTest(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}
