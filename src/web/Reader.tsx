// Personal reader, phone first. The whole surah scrolls like a mushaf page; the ayah being recited
// is highlighted word by word (with that word's meaning) and the page keeps it in view. Speak to
// move ("go to Surah Maryam", "show the ayah about the orphan", "English only") or type. It shares
// the control page's session, so a stream overlay, if open, follows along too.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResult, ControlClientMessage, ControlServerMessage, ControlSnapshot, CreditView } from '../shared/contracts';
import { SonioxCapture, type CaptureStatus } from './audio/soniox-session';
import { access, connect, formatListening, listeningLine, type Access, u } from './net';
import { toQpcHafsEncoding } from '../shared/display-encoding';
import { arabicNumber } from './VerseDisplay';
import { NurraBadge } from './Nurra';
import { SharedHours } from './Sponsor';

type Ayah = { key: string; ayah: number; arabic: string; english: string; glosses: Array<string | null> | null };
type Surah = { number: number; name: string; nameArabic: string; translation: string; glossCredit: string | null; ayahs: Ayah[] };
type Auth = 'checking' | 'owner' | 'unauthorized' | 'unavailable';

/** Binds the ayah-end ornament to the last word so a line never starts with it. */
const NBSP = String.fromCharCode(0xa0);

/** Per-device memory: the last place and language, and today's recited ayahs. Never required. */
type Saved = { key?: string; name?: string; lang?: 'both' | 'arabic' | 'english'; day?: string; recited?: string[] };
const today = () => new Date().toLocaleDateString('en-CA');
function loadSaved(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem('qo.reader') ?? '{}') as Saved;
    return s.day === today() ? s : { ...s, day: today(), recited: [] };
  } catch {
    return {};
  }
}
function save(patch: Saved) {
  try {
    localStorage.setItem('qo.reader', JSON.stringify({ ...loadSaved(), ...patch }));
  } catch {
    /* storage unavailable (private window): nothing is remembered */
  }
}

/** Requests shown on the welcome: tapping one runs it, which also teaches what can be said. */
const TRY = ['Surah Al-Mulk', 'Surah about elephants', 'Ayat al-Kursi', 'Al-Fatihah'];

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
const MenuIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path fill="currentColor" d="M4 6.5h16v2H4v-2Zm0 4.5h16v2H4v-2Zm0 4.5h10v2H4v-2Z" />
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
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [surahFailed, setSurahFailed] = useState(false);
  const [surahRetry, setSurahRetry] = useState(0);
  const [capture, setCapture] = useState<CaptureStatus>({ state: 'off', detail: null });
  const [surah, setSurah] = useState<Surah | null>(null);
  const [typing, setTyping] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ id: string; r: CommandResult } | null>(null);
  const [follow, setFollow] = useState(true);
  /** The start page, opened from the menu while a surah is up (recitation or a request leaves it). */
  const [home, setHome] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** When the reader last scrolled by hand (wheel, touch). */
  const lastScroll = useRef(-Infinity);
  const curKey = useRef<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Confirmations ("Opened 55:13.", "Showing Arabic only.") fade on their own; choices stay.
  useEffect(() => {
    const k = result?.r.kind;
    if (k !== 'navigate' && k !== 'control' && !(k === 'candidates' && result!.r.kind === 'candidates' && result!.r.confirmedKey && !moreOpen)) return;
    const t = setTimeout(() => setResult(null), 4000);
    return () => clearTimeout(t);
  }, [result, moreOpen]);
  /** A word the reader tapped to see its meaning (clears itself after a few seconds). */
  const [peek, setPeek] = useState<{ key: string; i: number } | null>(null);
  useEffect(() => {
    if (!peek) return;
    const t = setTimeout(() => setPeek(null), 4000);
    return () => clearTimeout(t);
  }, [peek]);
  /** Listening time left (hosted service only). */
  const [credits, setCredits] = useState<CreditView | null>(null);
  const micWrap = useRef<HTMLDivElement>(null);
  const [account, setAccount] = useState<Pick<Access, 'recoveryCode' | 'billing' | 'sponsored'>>({});
  const [timeOpen, setTimeOpen] = useState<false | 'time' | 'sponsor'>(false);
  // Back from Stripe's checkout page.
  const [returned] = useState(() => new URLSearchParams(location.search).get('paid'));
  const [donated] = useState(() => new URLSearchParams(location.search).has('donated'));
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
        setAccount({ recoveryCode: s.recoveryCode, billing: s.billing, sponsored: s.sponsored });
        if (new URLSearchParams(location.search).has('paid') || new URLSearchParams(location.search).has('donated') || new URLSearchParams(location.search).has('canceled')) history.replaceState(null, '', location.pathname);
        setAuth('owner');
        sock.current = connect(u('/ws/control'), {
          onStatus: (st, code) => {
            setConnection(st);
            if (code === 4401) setAuth('unauthorized');
            if (st !== 'open') setPending(false);
          },
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
      .catch(() => !cancelled && setAuth('unavailable'));
    return () => {
      cancelled = true;
      sock.current?.close();
      capRef.current?.stop();
    };
  }, []);

  const d = snap?.display;
  const cur = d?.verse ?? null;
  const lang = d?.style.language ?? 'both';
  const [saved, setSaved] = useState<Saved>(loadSaved);

  // Remember the place and language on this device.
  useEffect(() => {
    if (cur) save({ key: cur.key, name: cur.surahName });
  }, [cur?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (snap) save({ lang });
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  // A fresh session starts in the language this device last used.
  const langRestored = useRef(false);
  useEffect(() => {
    if (!snap || langRestored.current) return;
    langRestored.current = true;
    if (!snap.display.verse && saved.lang && saved.lang !== snap.display.style.language) send({ type: 'style', patch: { language: saved.lang } });
  }, [snap]); // eslint-disable-line react-hooks/exhaustive-deps
  // Today's progress: ayahs the tracker followed while this device was listening.
  useEffect(() => {
    if (!cur || !cap.listening || snap?.phase !== 'tracking') return;
    const s = loadSaved();
    if (s.recited?.includes(cur.key)) return;
    const recited = [...(s.recited ?? []), cur.key].slice(-2000);
    save({ recited, day: today() });
    setSaved({ ...s, recited });
  }, [cur?.key, snap?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // The surah being read, fetched once per surah.
  useEffect(() => {
    if (!cur || surah?.number === cur.surah) return;
    const controller = new AbortController();
    setSurahFailed(false);
    fetch(u(`/api/surah/${cur.surah}`), { credentials: 'same-origin', signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Surah unavailable');
        return r.json();
      })
      .then((s: Surah) => { if (!controller.signal.aborted) setSurah(s); })
      .catch(() => { if (!controller.signal.aborted) setSurahFailed(true); });
    return () => controller.abort();
  }, [cur?.surah, surahRetry]); // eslint-disable-line react-hooks/exhaustive-deps

  // Microphone level -> ring (a CSS variable, no re-render per frame).
  const isListening = cap.listening;
  useEffect(() => {
    if (!isListening) {
      micWrap.current?.style.setProperty('--level', '0');
      return;
    }
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      const l = cap.level();
      smooth = l > smooth ? smooth + (l - smooth) * 0.5 : smooth + (l - smooth) * 0.12;
      micWrap.current?.style.setProperty('--level', smooth.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isListening, cap]);

  curKey.current = cur?.key ?? null;
  useEffect(() => {
    if (!follow && performance.now() - lastScroll.current > 3000) setFollow(true);
  }, [cur?.key, d?.cursor?.from]);
  const prevKey = useRef<string | null>(null);
  useEffect(() => {
    if (cur?.key && prevKey.current && cur.key !== prevKey.current) setHome(false);
    prevKey.current = cur?.key ?? null;
  }, [cur?.key]);

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

  // Scrolling by hand pauses following only once the recited ayah is out of view (a nudge, or
  // scrolling back to it, keeps following). The next word recited after a few still seconds brings
  // the page back; just browsing without reciting leaves it where the reader put it.
  useEffect(() => {
    let t = 0;
    const check = () => {
      const el = document.querySelector<HTMLElement>('.r-word.active') ?? (curKey.current ? document.getElementById(`a-${curKey.current}`) : null);
      if (!el) return;
      const r = el.getBoundingClientRect();
      setFollow(r.bottom > 96 && r.top < window.innerHeight - 150);
    };
    const byHand = () => {
      lastScroll.current = performance.now();
      clearTimeout(t);
      t = window.setTimeout(check, 250);
    };
    // Momentum keeps scrolling after the finger lifts: keep checking while it settles.
    const onScroll = () => {
      if (performance.now() - lastScroll.current < 1500) byHand();
    };
    window.addEventListener('wheel', byHand, { passive: true });
    window.addEventListener('touchmove', byHand, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener('wheel', byHand);
      window.removeEventListener('touchmove', byHand);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  const run = (text: string) => {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    lastRequest.current = id;
    setPending(true);
    setResult(null);
    if (!send({ type: 'command', requestId: id, text, source: 'typed', show: true })) setPending(false);
    setFollow(true);
  };
  const goto = (key: string) => {
    send({ type: 'goto', key });
    setFollow(true);
    setHome(false);
  };

  if (auth === 'unavailable') {
    return <main className="r-gate"><h1>Couldn’t open the reader</h1><p>Check your connection, then try again.</p><button onClick={() => location.reload()}>Try again</button></main>;
  }
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
  const shownSurahForBar = shownSurah;
  const listeningElsewhere = !listening && ['recording', 'starting', 'reconnecting'].includes(snap.capture.phase);
  const status = connection !== 'open'
    ? 'Reconnecting… your place is saved. Please wait before choosing another ayah.'
    : !snap.setup.soniox
    ? 'Listening is unavailable right now. You can still read or type a request.'
    : listeningElsewhere
    ? 'Listening from another page. The reader follows along.'
    : !listening
    ? capture.state === 'error'
      ? capture.detail
      : (capture.detail ?? 'Tap the microphone and recite, or ask in English.')
    : capture.state === 'dozing'
      ? 'Listening… take your time. Nothing is sent while you’re quiet.'
      : snap.held
      ? 'Paused. The page stays here.'
      : snap.phase === 'tracking'
        ? `Following · ${cur?.key ?? ''}`
        : 'Listening… recite, or say “go to Surah Yaseen”.';

  return (
    <div className="reader" data-lang={lang}>
      <header className="r-top">
        <button className="r-menu-btn" onClick={() => setMenuOpen(true)} aria-label="Menu: home, surahs, listening time" aria-haspopup="dialog">
          <MenuIcon />
        </button>
        <div className="r-title">
          {cur && !home ? (
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
        {shownSurahForBar && cur && !home && (
          // Where in the surah: a hairline that fills as the recitation moves through it.
          <div className="r-progress" role="progressbar" aria-label="Position in the surah" aria-valuemin={1} aria-valuemax={shownSurahForBar.ayahs.length} aria-valuenow={cur.ayah}>
            <span style={{ transform: `scaleX(${cur.ayah / shownSurahForBar.ayahs.length})` }} />
          </div>
        )}
      </header>

      <main className="r-page">
        {cur && !home && !shownSurah && <div className="r-note" role="status">
          {surahFailed ? <><p>Couldn’t load this surah. Check your connection and try again.</p><button onClick={() => setSurahRetry((n) => n + 1)}>Try again</button></> : <p>Opening {cur.surahName}…</p>}
        </div>}
        {(!cur || home) && (
          <section className="r-welcome">
            <figure className="r-iqra-figure">
              <p className="r-iqra" lang="ar" dir="rtl">{toQpcHafsEncoding('ٱقۡرَأۡ')}</p>
              <figcaption className="r-iqra-meaning">
                <span className="r-iqra-en">Recite</span>
                <span className="r-iqra-ref">The first word revealed to the Prophet <bdi>ﷺ</bdi> (96:1)</span>
              </figcaption>
            </figure>
            <h1>Recite, and the page follows{NBSP}along.</h1>
            <p className="r-sub">Each word you recite lights up with its meaning, on your phone or on your stream.</p>
            <DemoLine />
            {cur && home ? (
              <button className="r-continue" onClick={() => { setHome(false); setFollow(true); }}>
                Continue at {cur.surahName} {cur.key}
              </button>
            ) : saved.key && (
              <button className="r-continue" onClick={() => goto(saved.key!)}>
                Continue at {saved.name ? `${saved.name} ` : ''}
                {saved.key}
              </button>
            )}
            {!!saved.recited?.length && <p className="r-today">Today: {saved.recited.length} {saved.recited.length === 1 ? 'ayah' : 'ayahs'} recited</p>}
            <div className="r-try">
              <p className="r-try-label">Start reciting, or ask for a surah</p>
              <div className="r-quick">
                {TRY.map((t) => (
                  <button key={t} onClick={() => run(t)}>“{t}”</button>
                ))}
              </div>
            </div>
            <details className="r-privacy">
              <summary>How your voice is used</summary>
              <p>When the microphone is on, your voice goes to our speech-recognition provider (Soniox) and nowhere else. We never record or keep it. Nothing is sent during long pauses, and listening switches itself off if you stop reciting. Reading and search never use the microphone.</p>
            </details>
            {credits && <SharedHours stats={account.sponsored} donations={account.billing?.donations ?? []} />}
            {/* Streamers: the same following, as a broadcast overlay driven from the control page. */}
            <a className="r-stream" href={u('/control')}>
              <span className="r-stream-k">Streaming?</span> Show the ayah you’re reciting on your stream with OBS
              <span aria-hidden="true"> →</span>
            </a>
            <SurahIndex onOpen={(n) => goto(`${n}:1`)} />
            <footer className="r-brand">
              <NurraBadge />
              <a href={u('/about')}>Why we built this</a>
            </footer>
          </section>
        )}
        {cur && !home && !shownSurah && <p className="r-loading">Opening {cur.surahName}…</p>}
        {shownSurah && !home && (
          <>
            <header className="r-surah">
              <div className="r-surah-frame">
                <span className="r-surah-ar" lang="ar" dir="rtl">سورة {shownSurah.nameArabic}</span>
              </div>
              <p className="r-surah-en">
                {shownSurah.name} · {shownSurah.ayahs.length} {shownSurah.ayahs.length === 1 ? 'ayah' : 'ayahs'}
              </p>
            </header>
            {shownSurah.number !== 1 && shownSurah.number !== 9 && (
              <p className="r-basmala" lang="ar" dir="rtl">{toQpcHafsEncoding('بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ')}</p>
            )}
            {shownSurah.ayahs.map((a) => {
              const isCur = a.key === cur!.key;
              const cursor = isCur ? d!.cursor : null;
              const words = toQpcHafsEncoding(a.arabic).split(/\s+/).filter(Boolean);
              return (
                <section
                  key={a.key}
                  id={`a-${a.key}`}
                  className={`r-ayah${isCur ? ' current' : ''}`}
                  onClick={() => goto(a.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      goto(a.key);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`${shownSurah.name} ${a.key}${isCur ? ', on screen' : ', follow from here'}`}
                  aria-current={isCur ? 'true' : undefined}
                >
                  {lang !== 'english' && (
                    <p className="r-ar" lang="ar" dir="rtl">
                      {words.map((w, i) => {
                        const active = !!cursor && i >= cursor.from && i <= cursor.to;
                        const passed = !!cursor && i < cursor.from;
                        const peeked = peek?.key === a.key && peek.i === i;
                        const gloss = peeked
                          ? (a.glosses?.[i] ?? null)
                          : active && lang === 'both' && i === cursor!.from
                            ? a.glosses?.slice(cursor!.from, cursor!.to + 1).filter(Boolean).join(' ') || null
                            : null;
                        return (
                          <span key={i}>
                            <span
                              className={`r-word${active ? ' active' : ''}${passed ? ' passed' : ''}${peeked ? ' peeked' : ''}`}
                              // Tapping a word shows its meaning; tapping elsewhere in the ayah follows from it.
                              onClick={a.glosses?.[i] ? (e) => { e.stopPropagation(); setPeek(peeked ? null : { key: a.key, i }); } : undefined}
                            >
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
      {donated && credits && <p className="r-toast">JazakAllahu khayran. Your sadaqah is added as soon as the payment goes through. May Allah accept it from you.</p>}
      {menuOpen && (
        <div className="r-modal" role="dialog" aria-modal="true" aria-label="Menu" onClick={() => setMenuOpen(false)} onKeyDown={(e) => e.key === 'Escape' && setMenuOpen(false)}>
          <nav className="r-time r-menu" onClick={(e) => e.stopPropagation()}>
            <button className="r-close" onClick={() => setMenuOpen(false)} aria-label="Close">×</button>
            <button className="r-menu-item" autoFocus onClick={() => { setHome(true); setMenuOpen(false); window.scrollTo(0, 0); }}>
              Home<span>{cur ? `Start page, with a way back to ${cur.surahName} ${cur.key}` : 'Start page'}</span>
            </button>
            <button className="r-menu-item" onClick={() => { setHome(true); setMenuOpen(false); requestAnimationFrame(() => document.getElementById('r-surahs')?.scrollIntoView({ block: 'start' })); }}>
              All surahs<span>Open any of the 114, by name or number</span>
            </button>
            {credits ? (
              <button className="r-menu-item" onClick={() => { setMenuOpen(false); setTimeOpen('time'); }}>
                Listening<span>{listeningLine(credits)}</span>
              </button>
            ) : (
              <p className="r-menu-item r-menu-static">Listening time<span>Unlimited: this reader runs on your own computer, with your own key</span></p>
            )}
            {credits && !!account.billing?.donations?.length && (
              <button className="r-menu-item" onClick={() => { setMenuOpen(false); setTimeOpen('sponsor'); }}>
                Give sadaqah<span>Keep listening free for everyone</span>
              </button>
            )}
            <a className="r-menu-item" href={u('/control')}>
              Put it on your stream<span>OBS overlay and stream controls</span>
            </a>
            <a className="r-menu-item" href={u('/about')}>
              Why we built this<span>What it costs, where your sadaqah goes, and its reward</span>
            </a>
            <div className="r-menu-brand">
              <NurraBadge />
            </div>
          </nav>
        </div>
      )}
      {timeOpen && credits && <ListeningTime credits={credits} account={account} focus={timeOpen} onClose={() => setTimeOpen(false)} />}

      {!follow && cur && !home && (
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
          <div className="r-mic-wrap" ref={micWrap} data-live={listening || undefined}>
            {/* The ring follows the microphone level: proof that it hears you, before any word appears. */}
            <span className="r-mic-ring" aria-hidden="true" />
            <button
              className={`r-mic${listening ? ' live' : ''}${starting ? ' starting' : ''}`}
              onClick={() => (listening || starting ? cap.stop() : void cap.start(null))}
              disabled={!listening && !starting && (!snap.setup.soniox || connection !== 'open')}
              aria-label={listening || starting ? 'Stop listening' : 'Start listening'}
            >
              {listening || starting ? <Stop /> : <Mic />}
            </button>
          </div>
          <div className="r-status" aria-live="polite">
            {connection === 'open' && (listening || listeningElsewhere) && heard ? (
              <span className="r-heard" lang="ar" dir="auto">{heard}</span>
            ) : (
              <span>{status}</span>
            )}
            {credits && (
              <button className={`r-credits${credits.available < 600 ? ' low' : ''}`} onClick={() => setTimeOpen('time')}>
                {listeningLine(credits)}
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
function ListeningTime({ credits, account, focus, onClose }: { credits: CreditView; account: Pick<Access, 'recoveryCode' | 'billing' | 'sponsored'>; focus: 'time' | 'sponsor'; onClose: () => void }) {
  const sponsorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus === 'sponsor') sponsorRef.current?.scrollIntoView({ block: 'start' });
  }, [focus]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const packs = account.billing?.packs ?? [];
  const personal = credits.freePerMonth > 0; // a personal monthly allowance is configured (optional)
  const renews = new Date(credits.renewsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const buy = async (pack: string) => {
    setBusy(pack);
    setNote(null);
    const r = await fetch(u('/api/billing/checkout'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pack }) }).catch(() => null);
    const body = (await r?.json().catch(() => ({}))) as { url?: string; error?: string };
    if (body?.url) location.href = body.url;
    else {
      setBusy(null);
      setNote(body?.error ?? 'The payment page could not be opened. Please try again.');
    }
  };
  const restore = async () => {
    const r = await fetch(u('/api/me/restore'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim() }) }).catch(() => null);
    if (r?.ok) location.reload();
    else setNote(((await r?.json().catch(() => ({}))) as { error?: string })?.error ?? 'That code did not work.');
  };
  return (
    <div className="r-modal" role="dialog" aria-modal="true" aria-label="Listening" onClick={onClose}>
      <section className="r-time" onClick={(e) => e.stopPropagation()}>
        <button className="r-close" onClick={onClose} aria-label="Close">×</button>
        <h2>Listening</h2>
        {personal ? (
          <>
            <p className="r-time-big">{credits.available > 0 ? `${formatListening(credits.available)} left` : 'None left right now'}</p>
            <p className="r-time-detail">
              Free each month: {formatListening(credits.freePerMonth)}. Used so far: {credits.freeUsedThisMonth < 60 ? 'none' : formatListening(credits.freeUsedThisMonth)}. Renews {renews}.
              {credits.paid > 0 ? ` Bought: ${formatListening(credits.paid)}.` : ''} Then shared hours, up to {formatListening(credits.sharePerDay)} a day.
            </p>
          </>
        ) : (
          <>
            <p className="r-time-big">Free, through sadaqah</p>
            <p className="r-time-detail">
              {credits.limitedBy === 'pool'
                ? 'The sponsored hours have run out for now. You can still read and search, and listening comes back as soon as someone gives.'
                  : credits.limitedBy === 'share'
                  ? `You’ve used today’s ${formatListening(credits.sharePerDay)}. They’re back tomorrow, so there’s enough for everyone.`
                  : `Everyone can recite up to ${formatListening(credits.sharePerDay)} a day, paid for by sadaqah. You have ${formatListening(credits.available)} left today.`}
            </p>
          </>
        )}
        <p className="r-time-free">Reading and search are always free. Only listening costs anything: about 12 cents for each hour of recitation.</p>
        <div ref={sponsorRef}>
          <SharedHours stats={account.sponsored} donations={account.billing?.donations ?? []} defaultOpen />
        </div>
        {packs.length > 0 && (
          <div className="r-packs">
            {packs.map((p) => (
              <button key={p.id} disabled={!!busy} onClick={() => void buy(p.id)}>
                <span>{p.label}</span>
                <strong>{busy === p.id ? 'Opening…' : p.price}</strong>
              </button>
            ))}
          </div>
        )}
        {account.recoveryCode && (packs.length > 0 || credits.paid > 0) && (
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

/**
 * The welcome's demonstration: Al-Fatihah 1:2 as the reader will show it, each word lighting up in
 * turn with its meaning (from the word-by-word data), at an easy reciting pace. Static with reduced
 * motion.
 */
function DemoLine() {
  const [ayah, setAyah] = useState<Ayah | null>(null);
  const [i, setI] = useState(0);
  useEffect(() => {
    fetch(u('/api/surah/1'), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Surah | null) => s && setAyah(s.ayahs[1]))
      .catch(() => undefined);
  }, []);
  const words = ayah ? toQpcHafsEncoding(ayah.arabic).split(/\s+/).filter(Boolean) : [];
  useEffect(() => {
    if (!words.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setTimeout(() => setI((n) => (n + 1) % (words.length + 1)), i === words.length ? 1600 : 1100);
    return () => clearTimeout(t);
  }, [i, words.length]);
  if (!ayah) return <div className="r-demo" aria-hidden="true" />;
  return (
    <figure className="r-demo" aria-label="Example: each recited word lights up with its meaning">
      <p className="r-ar" lang="ar" dir="rtl" aria-hidden="true">
        {words.map((w, k) => (
          <span key={k}>
            <span className={`r-word${k === i ? ' active' : ''}${k < i ? ' passed' : ''}`}>
              {w}
              {k === i && ayah.glosses?.[k] && <span className="r-gloss" lang="en" dir="ltr">{ayah.glosses[k]}</span>}
            </span>{' '}
          </span>
        ))}
      </p>
    </figure>
  );
}

type ChapterRow = { number: number; nameSimple: string; nameArabic: string; verseCount: number };

/** Every surah, findable by English name, Arabic name or number. */
function SurahIndex({ onOpen }: { onOpen: (n: number) => void }) {
  const [list, setList] = useState<ChapterRow[] | null>(null);
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => {
    fetch(u('/api/chapters'), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((l: ChapterRow[] | null) => l && setList(l))
      .catch(() => undefined);
  }, []);
  if (!list) return null;
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = q.trim();
  const matches = t ? list.filter((c) => String(c.number) === t || (flat(t) && flat(c.nameSimple).includes(flat(t))) || c.nameArabic.includes(t)) : list;
  const shown = t || all ? matches : matches.slice(0, 12);
  return (
    <section className="r-index" id="r-surahs" aria-label="All surahs">
      <h2>All surahs</h2>
      <input className="r-index-find" type="search" placeholder="Find a surah by name or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a surah" />
      <ol className="r-index-list">
        {shown.map((c) => (
          <li key={c.number}>
            <button onClick={() => onOpen(c.number)} aria-label={`${c.number}. ${c.nameSimple}, ${c.verseCount} ayahs`}>
              <span className="r-index-n">{c.number}</span>
              <span className="r-index-en">
                {c.nameSimple}
                <small>{c.verseCount} ayahs</small>
              </span>
              <span className="r-index-ar" lang="ar" dir="rtl">{c.nameArabic}</span>
            </button>
          </li>
        ))}
      </ol>
      {!shown.length && <p className="r-index-none">No surah matches “{t}”.</p>}
      {!t && !all && (
        <button className="r-index-more" onClick={() => setAll(true)}>
          Show all 114 surahs
        </button>
      )}
    </section>
  );
}
