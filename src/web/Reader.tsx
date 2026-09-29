// Personal reader, phone first. The whole surah scrolls like a mushaf page; the ayah being recited
// is highlighted word by word (with that word's meaning) and the page keeps it in view. Speak to
// move ("go to Surah Maryam", "show the ayah about the orphan", "English only") or type. It shares
// the control page's session, so a stream overlay, if open, follows along too.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResult, ControlClientMessage, ControlServerMessage, ControlSnapshot, CreditView } from '../shared/contracts';
import { SonioxCapture, type CaptureStatus } from './audio/soniox-session';
import { access, connect, formatListening, type Access } from './net';
import { toQpcHafsEncoding } from '../shared/display-encoding';
import { arabicNumber } from './VerseDisplay';

type Ayah = { key: string; ayah: number; arabic: string; english: string; glosses: Array<string | null> | null };
type Surah = { number: number; name: string; nameArabic: string; translation: string; glossCredit: string | null; ayahs: Ayah[] };
type Auth = 'checking' | 'owner' | 'unauthorized';

/** Binds the ayah-end ornament to the last word so a line never starts with it. */
const NBSP = String.fromCharCode(0xa0);

const QUICK = [
  { n: 1, name: 'Al-Fatihah' },
  { n: 36, name: 'Ya-Sin' },
  { n: 18, name: 'Al-Kahf' },
  { n: 55, name: 'Ar-Rahman' },
  { n: 67, name: 'Al-Mulk' },
  { n: 112, name: 'Al-Ikhlas' },
];

const Mic = () => (
  <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
    <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
  </svg>
);
const Stop = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
);
const Keys = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path fill="currentColor" d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm0 2v8h16V8H4Zm2 1h2v2H6V9Zm3 0h2v2H9V9Zm3 0h2v2h-2V9Zm3 0h3v2h-3V9ZM6 12h2v2H6v-2Zm3 0h6v2H9v-2Zm7 0h2v2h-2v-2Z" />
  </svg>
);

export function Reader() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [snap, setSnap] = useState<ControlSnapshot | null>(null);
  const [capture, setCapture] = useState<CaptureStatus>({ state: 'off', detail: null });
  const [surah, setSurah] = useState<Surah | null>(null);
  const [typing, setTyping] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ id: string; r: CommandResult } | null>(null);
  const [follow, setFollow] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  /** Listening time left (hosted service only). */
  const [credits, setCredits] = useState<CreditView | null>(null);
  const [account, setAccount] = useState<Pick<Access, 'recoveryCode' | 'billing'>>({});
  const [timeOpen, setTimeOpen] = useState(false);
  // Back from Stripe's checkout page.
  const [returned] = useState(() => new URLSearchParams(location.search).get('paid'));
  const sock = useRef<ReturnType<typeof connect> | null>(null);
  const lastRequest = useRef<string | null>(null);
  const send = useCallback((m: ControlClientMessage) => sock.current?.send(m) ?? false, []);
  const capRef = useRef<SonioxCapture | null>(null);
  if (!capRef.current) capRef.current = new SonioxCapture((m) => send(m), (s) => setCapture(s), () => undefined);
  const cap = capRef.current;

  useEffect(() => {
    document.documentElement.dataset.surface = 'reader';
    let cancelled = false;
    access()
      .then((s) => {
        if (cancelled) return;
        if (!s.owner) return setAuth('unauthorized');
        if (s.credits) setCredits(s.credits);
        setAccount({ recoveryCode: s.recoveryCode, billing: s.billing });
        if (new URLSearchParams(location.search).has('paid') || new URLSearchParams(location.search).has('canceled')) history.replaceState(null, '', location.pathname);
        setAuth('owner');
        sock.current = connect('/ws/control', {
          onStatus: (_st, code) => code === 4401 && setAuth('unauthorized'),
          shouldRetry: (code) => code !== 4401,
          onMessage: (data) => {
            const m = data as ControlServerMessage;
            if (m.type === 'snapshot') setSnap(m.snapshot);
            else if (m.type === 'credits') setCredits(m.credits);
            else if (m.type === 'command_pending') {
              if (m.requestId.startsWith('listen:')) lastRequest.current = m.requestId;
              if (m.requestId === lastRequest.current) {
                setPending(true);
                setResult(null);
              }
            } else if (m.type === 'command_result' && m.requestId === lastRequest.current) {
              setPending(false);
              setResult({ id: m.requestId, r: m.result });
              setMoreOpen(false);
              if (m.result.kind !== 'candidates' || !m.result.refining) setTyping(false);
            }
          },
        });
      })
      .catch(() => !cancelled && setAuth('unauthorized'));
    return () => {
      cancelled = true;
      sock.current?.close();
      capRef.current?.stop();
    };
  }, []);

  const d = snap?.display;
  const cur = d?.verse ?? null;
  const lang = d?.style.language ?? 'both';

  // The surah being read, fetched once per surah.
  useEffect(() => {
    if (!cur || surah?.number === cur.surah) return;
    fetch(`/api/surah/${cur.surah}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Surah | null) => s && setSurah(s))
      .catch(() => undefined);
  }, [cur?.surah]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the recited word (or the new ayah) in view, unless the reader scrolled away on purpose.
  useEffect(() => {
    if (!follow || !cur) return;
    const el = document.querySelector<HTMLElement>('.r-word.active') ?? document.getElementById(`a-${cur.key}`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const top = 96;
    const bottom = window.innerHeight - 150;
    if (r.top < top || r.bottom > bottom) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [cur?.key, d?.cursor?.from, surah?.number, follow]);

  useEffect(() => {
    const away = () => setFollow(false);
    window.addEventListener('wheel', away, { passive: true });
    window.addEventListener('touchmove', away, { passive: true });
    return () => {
      window.removeEventListener('wheel', away);
      window.removeEventListener('touchmove', away);
    };
  }, []);

  const run = (text: string) => {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    lastRequest.current = id;
    setPending(true);
    setResult(null);
    send({ type: 'command', requestId: id, text, source: 'typed', show: true });
    setFollow(true);
  };
  const goto = (key: string) => {
    send({ type: 'goto', key });
    setFollow(true);
  };

  if (auth === 'unauthorized') {
    return (
      <main className="r-gate">
        <h1>Open your private link</h1>
        <p>This reader uses the link printed where the app was started (the same one as the control page).</p>
      </main>
    );
  }
  if (!snap) return <main className="r-gate"><p>Opening…</p></main>;

  const listening = cap.listening;
  const starting = capture.state === 'starting' || capture.state === 'reconnecting';
  const heard = `${snap.heard.final} ${snap.heard.provisional}`.trim().split(/\s+/).filter(Boolean).slice(-7).join(' ');
  const r = result?.r ?? null;
  const shownSurah = surah && cur && surah.number === cur.surah ? surah : null;
  const listeningElsewhere = !listening && ['recording', 'starting', 'reconnecting'].includes(snap.capture.phase);
  const status = listeningElsewhere
    ? 'Listening from another page. The reader follows along.'
    : !listening
    ? capture.state === 'error'
      ? capture.detail
      : (capture.detail ?? 'Tap the microphone and recite, or ask in English.')
    : snap.held
      ? 'Paused. The page stays here.'
      : snap.phase === 'tracking'
        ? `Following · ${cur?.key ?? ''}`
        : 'Listening… recite, or say “go to Surah Yaseen”.';

  return (
    <div className="reader" data-lang={lang}>
      <header className="r-top">
        <div className="r-title">
          {cur ? (
            <>
              <span className="r-name">{cur.surahName}</span>
              <span className="r-name-ar" lang="ar">{cur.surahNameArabic}</span>
              <span className="r-key">{cur.key}</span>
            </>
          ) : (
            <span className="r-name">Quran Reader</span>
          )}
        </div>
        <div className="r-langs" role="radiogroup" aria-label="Language">
          {([['arabic', 'عربي'], ['both', 'Both'], ['english', 'English']] as const).map(([v, label]) => (
            <button key={v} role="radio" aria-checked={lang === v} className={lang === v ? 'on' : ''} lang={v === 'arabic' ? 'ar' : 'en'} onClick={() => send({ type: 'style', patch: { language: v } })}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="r-page">
        {!cur && (
          <section className="r-welcome">
            <h1>Recite, and the Quran follows you.</h1>
            <p>Tap the microphone and start reciting any surah. Or just say it: “Go to Surah Al-Mulk”, “Show the ayah about the orphan”, “English only”.</p>
            <p className="r-privacy">Your voice is sent to our speech-recognition provider (Soniox) only while the microphone is on. We do not record or keep your audio. Reading and search never use the microphone.</p>
            <div className="r-quick">
              {QUICK.map((q) => (
                <button key={q.n} onClick={() => goto(`${q.n}:1`)}>{q.name}</button>
              ))}
            </div>
          </section>
        )}
        {cur && !shownSurah && <p className="r-loading">Opening {cur.surahName}…</p>}
        {shownSurah && (
          <>
            {shownSurah.number !== 1 && shownSurah.number !== 9 && (
              <p className="r-basmala" lang="ar" dir="rtl">{toQpcHafsEncoding('بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ')}</p>
            )}
            {shownSurah.ayahs.map((a) => {
              const isCur = a.key === cur!.key;
              const cursor = isCur ? d!.cursor : null;
              const words = toQpcHafsEncoding(a.arabic).split(/\s+/).filter(Boolean);
              return (
                <section key={a.key} id={`a-${a.key}`} className={`r-ayah${isCur ? ' current' : ''}`} onClick={() => goto(a.key)} aria-current={isCur ? 'true' : undefined}>
                  {lang !== 'english' && (
                    <p className="r-ar" lang="ar" dir="rtl">
                      {words.map((w, i) => {
                        const active = !!cursor && i >= cursor.from && i <= cursor.to;
                        const passed = !!cursor && i < cursor.from;
                        const gloss = active && lang === 'both' && i === cursor!.from ? a.glosses?.slice(cursor!.from, cursor!.to + 1).filter(Boolean).join(' ') : null;
                        return (
                          <span key={i}>
                            <span className={`r-word${active ? ' active' : ''}${passed ? ' passed' : ''}`}>
                              {w}
                              {gloss && <span className="r-gloss" lang="en" dir="ltr">{gloss}</span>}
                            </span>
                            {i < words.length - 1 ? ' ' : <>{NBSP}<span className="r-mark">{arabicNumber(a.ayah)}</span></>}
                          </span>
                        );
                      })}
                    </p>
                  )}
                  {lang !== 'arabic' && (
                    <p className="r-en" lang="en">
                      {lang === 'english' && <span className="r-num">{a.ayah}</span>}
                      {a.english}
                    </p>
                  )}
                </section>
              );
            })}
            <p className="r-credit">
              {shownSurah.translation}
              {shownSurah.glossCredit ? ` · ${shownSurah.glossCredit}` : ''}
            </p>
          </>
        )}
      </main>

      {returned && credits && <p className="r-toast">Thank you. Your listening time is added as soon as the payment is confirmed.</p>}
      {timeOpen && credits && <ListeningTime credits={credits} account={account} onClose={() => setTimeOpen(false)} />}

      {!follow && cur && (
        <button className="r-back" onClick={() => setFollow(true)}>
          Back to {cur.key}
        </button>
      )}

      <footer className="r-dock">
        {(pending || r) && (
          <div className="r-sheet" role="status">
            {pending && <p className="r-note">Finding it…</p>}
            {!pending && r?.kind === 'navigate' && <p className="r-note ok">Opened {r.key}.</p>}
            {!pending && r?.kind === 'control' && <p className="r-note ok">{r.label}</p>}
            {!pending && (r?.kind === 'no_match' || r?.kind === 'invalid_reference') && <p className="r-note warn">{r.message}</p>}
            {!pending && r?.kind === 'candidates' && r.confirmedKey && r.confirmedKey === cur?.key && !moreOpen && (
              // The best match is already on the page: just say so, with the alternatives one tap away.
              <p className="r-note ok">
                Opened {r.cards.find((c) => c.key === r.confirmedKey)?.surahName ?? ''} {r.confirmedKey}.{' '}
                {r.cards.length > 1 && (
                  <button className="r-more" onClick={() => setMoreOpen(true)}>
                    Not it? {r.cards.length - 1} more
                  </button>
                )}
              </p>
            )}
            {!pending && r?.kind === 'candidates' && !(r.confirmedKey && r.confirmedKey === cur?.key && !moreOpen) && (
              <ul className="r-results">
                {r.cards.slice(0, 4).map((c) => (
                  <li key={c.key}>
                    <button
                      onClick={() => {
                        send({ type: 'show_result', requestId: result!.id, key: c.key });
                        send({ type: 'hold', on: false });
                        setResult(null);
                        setFollow(true);
                      }}
                    >
                      <span className="r-res-key">{c.surahName} {c.key}{c.key === r.confirmedKey ? ' · best match' : ''}</span>
                      <span className="r-res-en">{c.english}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!pending && r && (
              <button className="r-close" onClick={() => setResult(null)} aria-label="Close">
                ×
              </button>
            )}
          </div>
        )}
        {typing && (
          <form
            className="r-type"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) run(query.trim());
            }}
          >
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Surah Maryam 3, or what the ayah says" aria-label="Type a request" enterKeyHint="go" />
            <button type="submit" disabled={!query.trim()}>Go</button>
          </form>
        )}
        <div className="r-controls">
          <button className="r-kbd" onClick={() => setTyping((t) => !t)} aria-pressed={typing} aria-label="Type instead">
            <Keys />
          </button>
          <button
            className={`r-mic${listening ? ' live' : ''}${starting ? ' starting' : ''}`}
            onClick={() => (listening || starting ? cap.stop() : void cap.start(null))}
            disabled={!snap.setup.soniox}
            aria-label={listening || starting ? 'Stop listening' : 'Start listening'}
          >
            {listening || starting ? <Stop /> : <Mic />}
          </button>
          <div className="r-status" aria-live="polite">
            {(listening || listeningElsewhere) && heard ? (
              <span className="r-heard" lang="ar" dir="auto">{heard}</span>
            ) : (
              <span>{status}</span>
            )}
            {credits && (
              <button className={`r-credits${credits.available < 600 ? ' low' : ''}`} onClick={() => setTimeOpen(true)}>
                {credits.available > 0 ? `${formatListening(credits.available)} of listening left` : account.billing ? 'No listening time left · get more' : 'No listening time left'}
                {credits.available > 0 && credits.paid === 0 && credits.limitedBy === null ? ' this month' : ''}
              </button>
            )}
            {snap.held && (
              <button className="r-resume" onClick={() => send({ type: 'hold', on: false })}>
                Follow my recitation
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

/** Listening time: what is left, buying more (when offered), and keeping it on another device. */
function ListeningTime({ credits, account, onClose }: { credits: CreditView; account: Pick<Access, 'recoveryCode' | 'billing'>; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const renews = new Date(credits.renewsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const buy = async (pack: string) => {
    setBusy(pack);
    setNote(null);
    const r = await fetch('/api/billing/checkout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pack }) }).catch(() => null);
    const body = (await r?.json().catch(() => ({}))) as { url?: string; error?: string };
    if (body?.url) location.href = body.url;
    else {
      setBusy(null);
      setNote(body?.error ?? 'The payment page could not be opened. Please try again.');
    }
  };
  const restore = async () => {
    const r = await fetch('/api/me/restore', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim() }) }).catch(() => null);
    if (r?.ok) location.reload();
    else setNote(((await r?.json().catch(() => ({}))) as { error?: string })?.error ?? 'That code did not work.');
  };
  return (
    <div className="r-modal" role="dialog" aria-modal="true" aria-label="Listening time" onClick={onClose}>
      <section className="r-time" onClick={(e) => e.stopPropagation()}>
        <button className="r-close" onClick={onClose} aria-label="Close">×</button>
        <h2>Listening time</h2>
        <p className="r-time-big">{credits.available > 0 ? `${formatListening(credits.available)} left` : 'None left right now'}</p>
        <p className="r-time-detail">
          Free each month: {formatListening(credits.freePerMonth)}{credits.freePerDay < credits.freePerMonth ? ` (up to ${formatListening(credits.freePerDay)} a day)` : ''}. Used so far: {credits.freeUsedThisMonth < 60 ? 'none' : formatListening(credits.freeUsedThisMonth)}. Renews {renews}.
          {credits.paid > 0 ? ` Bought: ${formatListening(credits.paid)}.` : ''}
          {credits.limitedBy === 'network' ? " Today's free time on this network is used up." : credits.limitedBy === 'service' ? " Today's free time for everyone is used up." : ''}
        </p>
        <p className="r-time-free">Reading, search and everything about the Quran are free. Only live listening uses time, because speech recognition costs money per minute.</p>
        {account.billing && (
          <div className="r-packs">
            {account.billing.packs.map((p) => (
              <button key={p.id} disabled={!!busy} onClick={() => void buy(p.id)}>
                <span>{p.label}</span>
                <strong>{busy === p.id ? 'Opening…' : p.price}</strong>
              </button>
            ))}
          </div>
        )}
        {account.recoveryCode && (
          <details className="r-recover">
            <summary>Keep your time on another device</summary>
            <p>Save this code. Enter it on another phone or computer (or after clearing your browser) to keep your listening time.</p>
            <div className="r-code">
              <code>{account.recoveryCode}</code>
              <button onClick={() => void navigator.clipboard.writeText(account.recoveryCode!).then(() => setNote('Copied.'))}>Copy</button>
            </div>
            <div className="r-code">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste a saved code" aria-label="Recovery code" />
              <button disabled={!code.trim()} onClick={() => void restore()}>Restore</button>
            </div>
          </details>
        )}
        {note && <p className="r-note">{note}</p>}
      </section>
    </div>
  );
}
