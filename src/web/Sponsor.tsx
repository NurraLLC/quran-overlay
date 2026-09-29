// The shared listening hours. Listening is free for everyone and paid for by gifts to one pool; this
// shows that honestly and quietly: closed, a single bar (this month's gifts toward the month's
// goal) with the hours available right now; open, what gifts have done (a field of hours, gold for
// those already recited), recent activity, and the way to give. It refreshes itself, so it moves as
// people give and recite. Totals and counts only, never who.
import { useEffect, useRef, useState } from 'react';
import type { Donation, PoolStats } from './net';
import { u } from './net';

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

const hours = (s: number) => Math.round(s / 3600);
/** "$10.00" reads as "$10". */
const price = (p: string) => p.replace(/\.00$/, '');
const MAX_DOTS = 240;

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

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
    return () => clearInterval(t);
  }, []);
  return stats;
}

export function SharedHours({ stats: initial, donations, defaultOpen = false }: { stats: PoolStats | undefined; donations: Donation[]; defaultOpen?: boolean }) {
  const stats = useLivePool(initial);
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!stats) return null;
  const left = hours(stats.left);
  const month = hours(stats.givenThisMonth);
  const goal = Math.max(1, hours(stats.goalThisMonth));
  const pct = Math.min(100, (month / goal) * 100);
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
      <button className="r-pool-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="r-pool-line">
          <span className="r-pool-now">
            <strong>{left.toLocaleString()}</strong> {left === 1 ? 'hour' : 'hours'} of recitation sponsored
          </span>
          <span className="r-pool-cta">{open ? 'Close' : donations.length ? 'Give sadaqah' : 'See more'}</span>
        </span>
        <span className="r-pool-track" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="r-pool-sub">
          Free for everyone through your sadaqah · {month >= goal ? `${month.toLocaleString()} hours given this month, alhamdulillah` : `${month.toLocaleString()} of ${goal.toLocaleString()} hours given this month`}
        </span>
      </button>
      {open && (
        <div className="r-pool-body">
          <p className="r-pool-why">
            Listening is free for everyone. Each hour of recitation costs us about 12 cents, and every one of those hours is paid for by sadaqah.
            {example ? ` ${price(example.price)} covers about ${example.hours} hours of someone’s recitation.` : ''}
          </p>
          {stats.given > 0 && <HourField given={hours(stats.given)} used={Math.min(hours(stats.given), hours(stats.used))} />}
          <ul className="r-pool-activity">
            {stats.giftsThisMonth > 0 && (
              <li>
                {stats.giftsThisMonth} {stats.giftsThisMonth === 1 ? 'gift' : 'gifts'} this month{stats.lastGiftAt ? `, the most recent ${ago(stats.lastGiftAt)}` : ''}
              </li>
            )}
            {stats.recitersThisWeek > 0 && (
              <li>
                {hours(stats.recitedThisWeek) || 'Under an'} {hours(stats.recitedThisWeek) === 1 ? 'hour' : 'hours'} recited this week by {stats.recitersThisWeek} {stats.recitersThisWeek === 1 ? 'person' : 'people'}
              </li>
            )}
          </ul>
          {donations.length > 0 && (
            <div className="r-give-amounts">
              {donations.map((d) => (
                <button key={d.amountCents} disabled={busy !== null} onClick={() => void give(d.amountCents)}>
                  <strong>{busy === d.amountCents ? 'Opening…' : price(d.price)}</strong>
                  <span>{d.hours} hours</span>
                </button>
              ))}
            </div>
          )}
          {note && <p className="r-note">{note}</p>}
          <a className="r-give-more" href={u('/about')}>
            Where your sadaqah goes, and its reward
          </a>
        </div>
      )}
    </section>
  );
}

function HourField({ given, used }: { given: number; used: number }) {
  const per = Math.max(1, Math.ceil(given / MAX_DOTS));
  const dots = Math.ceil(given / per);
  const lit = Math.round(used / per);
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className={`r-give-field${shown ? ' shown' : ''}`} ref={ref}>
      <div className="r-give-dots" role="img" aria-label={`${given} hours given so far, ${used} of them already recited`}>
        {Array.from({ length: dots }, (_, i) => (
          <i key={i} className={i < lit ? 'lit' : ''} style={{ transitionDelay: `${Math.min(i, 120) * 6}ms` }} />
        ))}
      </div>
      <p className="r-give-legend">
        {given.toLocaleString()} hours given so far, and <span className="lit">{used.toLocaleString()} already recited</span>. Each dot is {per === 1 ? 'an hour' : `${per} hours`}.
      </p>
    </div>
  );
}
