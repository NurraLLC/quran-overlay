// Lifetime community funding: total given, time used and time left. No monthly target,
// donor names, personal purchases or leaderboard. Optional donations add to everyone's time.
import { useEffect, useState } from 'react';
import type { Donation, PoolStats } from './net';
import { formatListening, u } from './net';

/** Opens Stripe's page for a gift; returns an error to show if it could not. */
export async function openDonation(amountCents: number): Promise<string | null> {
  const r = await fetch(u('/api/billing/donate'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amountCents }) }).catch(() => null);
  const body = (await r?.json().catch(() => ({}))) as { url?: string; error?: string };
  if (body?.url) {
    location.href = body.url;
    return null;
  }
  return body?.error ?? 'The payment page could not be opened. Please try again.';
}

/** "$10.00" reads as "$10". */
const price = (p: string) => p.replace(/\.00$/, '');
const duration = (seconds: number) => seconds === 0 ? '0 h' : `${seconds < 0 ? '−' : ''}${formatListening(Math.abs(seconds))}`;

/** Live pool numbers: the initial ones, refreshed every minute while the page is visible. */
function useLivePool(initial: PoolStats | undefined): PoolStats | undefined {
  const [stats, setStats] = useState(initial);
  useEffect(() => setStats(initial), [initial]);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      fetch(u('/api/pool'), { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s: PoolStats | null) => s && setStats(s))
        .catch(() => undefined);
    };
    const t = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, []);
  return stats;
}

export function SharedHours({ stats: initial, donations, testMode = false, defaultOpen = false }: { stats: PoolStats | undefined; donations: Donation[]; testMode?: boolean; defaultOpen?: boolean }) {
  const stats = useLivePool(initial);
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!stats) return null;
  const pct = stats.given > 0 ? Math.min(100, Math.max(0, (stats.left / stats.given) * 100)) : 0;
  const give = async (c: number) => {
    setBusy(c);
    setNote(null);
    const err = await openDonation(c);
    if (err) {
      setBusy(null);
      setNote(err);
    }
  };
  const example = donations[Math.min(1, donations.length - 1)];

  return (
    <section className={`r-pool${open ? ' open' : ''}`} aria-label="Sponsored recitation hours">
      <div className="r-pool-overview">
        <p className="r-pool-title">Community support keeps recitation free.</p>
        <dl className="r-pool-totals">
          <div><dt>Community funded</dt><dd>{duration(stats.given)}</dd></div>
          <div><dt>Listening & costs</dt><dd>{duration(stats.used + (stats.costs ?? 0))}</dd></div>
          <div><dt>{stats.operatingReserve ? 'Available for listening' : 'Hours remaining'}</dt><dd>{duration(stats.left)}</dd></div>
        </dl>
      </div>
      <p className="r-budget-note">{duration(stats.used)} used for listening · {duration(stats.costs ?? 0)} in other recorded costs</p>
      {!!stats.operatingReserve && <p className="r-budget-note">${((stats.operatingReserveUsdMicros ?? 0) / 1_000_000).toFixed(2)} set aside for running costs ({duration(stats.operatingReserve)}). This is reserved, not spent.</p>}
      <button className="r-pool-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="r-pool-line">
          <span className="r-pool-now">Shared by everyone</span>
          <span className="r-pool-cta">{open ? 'Close details' : 'Support Quran Reader'}</span>
        </span>
        <span className="r-pool-track" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      </button>
      {open && (
        <div className="r-pool-body">
          <p className="r-pool-why">
            Support listening, hosting, payment fees, and other running costs. This budget is shown as equivalent listening hours.
            {example ? ` ${price(example.price)} represents about ${example.hours} hours before fees and project costs.` : ''}
          </p>
          <p className="r-pool-sub">One-time support for Quran Reader, operated by Nurra LLC. No subscription or reader account. Contributions are not tax-deductible charitable donations.</p>
          {donations.length > 0 && (
            <>
            {testMode && <p className="r-support-status" role="status">Test checkout — no real money. Use Stripe test details only. These hours belong to the test pool.</p>}
            <div className="r-give-amounts">
              {donations.map((d) => (
                <button key={d.amountCents} disabled={busy !== null} onClick={() => void give(d.amountCents)}>
                  <strong>{busy === d.amountCents ? 'Opening…' : price(d.price)}</strong>
                  <span>About {d.hours} hours before costs</span>
                </button>
              ))}
            </div>
            </>
          )}
          {!donations.length && <p className="r-support-status" role="status">Online contributions aren’t open yet. We’re setting up payments. You can already use the reader and share it with others.</p>}
          {donations.length > 0 && <p className="r-pool-sub">Choose an amount to continue to Stripe’s secure checkout.</p>}
          {note && <p className="r-note" role="alert">{note}</p>}
          <p className="r-pool-sub">Time counts while recognition is connected, including short pauses. Usage is added when a session ends; totals refresh every minute.</p>
          <p className="r-pool-sub">Conversion: ${( (stats.centsPerHour ?? 13) / 100).toFixed(2)} per hour equivalent. Listening is estimated from connected time. Other costs reduce the balance when recorded; this is not a live provider invoice.</p>
          <a className="r-give-more" href={u('/about')}>
            Why support this project?
          </a>
        </div>
      )}
    </section>
  );
}
