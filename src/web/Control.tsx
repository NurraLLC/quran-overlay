// Reciter's control page. Everything here is private to the broadcaster; only the display state
// (mirrored in the preview) reaches the audience.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResult, ControlClientMessage, ControlServerMessage, ControlSnapshot, CreditView, SearchCard } from '../shared/contracts';
import { SonioxCapture, type CaptureStatus } from './audio/soniox-session';
import { access, connect, formatListening, listeningLine } from './net';
import { NurraBadge } from './Nurra';
import { toQpcHafsEncoding } from '../shared/display-encoding';
import { StageFrame, VerseDisplay, useFontsReady, type LayoutInfo } from './VerseDisplay';

type ChapterRow = { number: number; nameSimple: string; nameArabic: string; verseCount: number };
type Auth = 'checking' | 'owner' | 'unauthorized';

/** Stream colours: gold (the default), and a few that sit well over most footage. */
const ACCENTS: Array<[string, string]> = [
  ['#cfaa62', 'Gold'],
  ['#5fbf98', 'Emerald'],
  ['#7fb2e5', 'Sky'],
  ['#e39aa8', 'Rose'],
  ['#b99be6', 'Lavender'],
  ['#e8e3d6', 'Pearl'],
];

function statusLine(s: ControlSnapshot): { tone: string; title: string; detail: string } {
  const key = s.display.verse ? `${s.display.verse.surahName} ${s.display.verse.key}` : null;
  const onScreen = key ? `${key} is on screen.` : 'The screen is empty.';
  switch (s.phase) {
    case 'idle':
      return { tone: 'idle', title: 'Not listening', detail: onScreen };
    case 'listening_unlocated':
      return { tone: 'seeking', title: 'Listening — finding your place', detail: key ? `${onScreen}` : 'Begin reciting; the ayah appears once it is recognized.' };
    case 'tracking':
      return { tone: 'following', title: `Following · ${key ?? '—'}`, detail: 'The screen moves with your recitation.' };
    case 'uncertain':
      return { tone: 'seeking', title: `Checking · holding ${key ?? '—'}`, detail: 'Recent words did not match this ayah. It stays up briefly while the place is found again.' };
    case 'held':
      return {
        tone: 'held',
        title: `Paused · screen holds ${s.display.verse?.key ?? 'nothing'}`,
        detail:
          s.trackerVerse && s.trackerVerse !== s.display.verse?.key
            ? `You seem to be at ${s.trackerVerse}. Resume following to show it.`
            : ['recording', 'starting', 'reconnecting'].includes(s.capture.phase)
              ? 'Still listening privately; the screen will not move until you resume.'
              : 'The screen will not move until you resume following.',
      };
    case 'dozing':
      return { tone: 'following', title: 'Listening · waiting for you to recite', detail: `${key ? `${key} stays on screen. ` : ''}Nothing is sent while you are quiet; recite and it continues at once.` };
    case 'stopped':
      return { tone: 'idle', title: 'Not listening', detail: key ? `${key} stays on screen until you change it.` : 'The screen is empty.' };
    case 'disconnected':
    case 'error':
      return { tone: 'error', title: 'Listening stopped', detail: s.capture.detail ?? 'The microphone stream ended unexpectedly.' };
  }
}

export function Control() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [snap, setSnap] = useState<ControlSnapshot | null>(null);
  const [conn, setConn] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [capture, setCapture] = useState<CaptureStatus>({ state: 'off', detail: null });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; r: CommandResult } | null>(null);
  const [copied, setCopied] = useState(false);
  /** Listening time left (hosted service only). */
  const [credits, setCredits] = useState<CreditView | null>(null);
  const fontsReady = useFontsReady();
  const sock = useRef<ReturnType<typeof connect> | null>(null);
  const lastRequest = useRef<string | null>(null);

  const send = useCallback((m: ControlClientMessage) => sock.current?.send(m) ?? false, []);
  const captureRef = useRef<SonioxCapture | null>(null);
  if (!captureRef.current) {
    captureRef.current = new SonioxCapture(
      (m) => send(m),
      (s) => setCapture(s),
      () => undefined,
    );
  }
  const cap = captureRef.current;

  // Live speed meter: how far the screen trails the voice. Measured after the preview paints the
  // change, against Soniox's audio clock (zero = first microphone chunk). Mic/driver input latency
  // is not included, so real values are slightly higher.
  const [speedView, setSpeedView] = useState<{ ayah: number[]; word: number[]; last: number | null }>({ ayah: [], word: [], last: null });
  const lastSpeedRev = useRef(-1);
  // Diagnostic hook for the speed lab (scripts/speedlab): the audio clock's zero point.
  useEffect(() => {
    (window as unknown as { __qoAudioOrigin?: () => number | null }).__qoAudioOrigin = () => cap.audioOrigin;
  }, [cap]);
  const measureSpeed = useCallback(
    (sp: ControlSnapshot['speed']) => {
      if (!sp || sp.revision === lastSpeedRev.current) return;
      lastSpeedRev.current = sp.revision;
      const origin = cap.audioOrigin;
      if (origin === null || sp.captureEpoch !== cap.captureEpoch) return;
      requestAnimationFrame(() =>
        setTimeout(() => {
          const lag = performance.now() - (origin + sp.heardEndMs);
          if (lag < -500 || lag > 30000) return;
          setSpeedView((v) => ({
            ayah: sp.verseChanged ? [...v.ayah, lag].slice(-60) : v.ayah,
            word: sp.verseChanged ? v.word : [...v.word, lag].slice(-120),
            last: sp.verseChanged ? lag : v.last,
          }));
        }, 0),
      );
    },
    [cap],
  );

  useEffect(() => {
    document.documentElement.dataset.surface = 'control';
    let cancelled = false;
    access()
      .then((s) => {
        if (cancelled) return;
        if (!s.owner) return setAuth('unauthorized');
        if (s.credits) setCredits(s.credits);
        setAuth('owner');
        fetch('/api/chapters', { credentials: 'same-origin' })
          .then((r) => r.json())
          .then(setChapters)
          .catch(() => undefined);
        sock.current = connect('/ws/control', {
          onStatus: (st, code) => {
            setConn(st);
            if (code === 4401) setAuth('unauthorized');
          },
          shouldRetry: (code) => code !== 4401,
          onMessage: (data) => {
            const m = data as ControlServerMessage;
            if (m.type === 'credits') setCredits(m.credits);
            else if (m.type === 'snapshot') {
              setSnap(m.snapshot);
              measureSpeed(m.snapshot.speed);
            }
            else if (m.type === 'command_pending') {
              if (m.requestId.startsWith('listen:')) { lastRequest.current = m.requestId; setResult(null); }
              if (m.requestId === lastRequest.current) setPendingId(m.requestId);
            } else if (m.type === 'command_result') {
              if (m.requestId !== lastRequest.current) return; // an older search never replaces a newer one
              setPendingId(null);
              setResult({ id: m.requestId, r: m.result });
            }
          },
        });
      })
      .catch(() => !cancelled && setAuth('unauthorized'));
    return () => {
      cancelled = true;
      sock.current?.close();
      captureRef.current?.stop();
    };
  }, []);

  const refreshDevices = useCallback(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setDevices(d.filter((x) => x.kind === 'audioinput' && x.deviceId)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);
  useEffect(() => {
    if (capture.state === 'recording') refreshDevices();
  }, [capture.state, refreshDevices]);

  const onLayout = useCallback(
    (info: LayoutInfo) => {
      if (!snap) return;
      send({ type: 'layout', revision: snap.display.revision, key: info.key, englishPages: info.englishPages, arabicPages: info.arabicPages, promotedToFullFrame: info.promotedToFullFrame });
    },
    [snap, send],
  );

  const runCommand = useCallback(
    (text: string, source: 'typed' | 'voice') => {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      lastRequest.current = id;
      setResult(null);
      setPendingId(id);
      send({ type: 'command', requestId: id, text, source });
    },
    [send],
  );

  // Keyboard: ←/→ navigate, H pause/resume, B hide/show. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey || !snap) return;
      if (e.key === 'ArrowRight') send({ type: 'nav', action: 'next' });
      else if (e.key === 'ArrowLeft') send({ type: 'nav', action: 'prev' });
      else if (e.key.toLowerCase() === 'h') send({ type: 'hold', on: !snap.held });
      else if (e.key.toLowerCase() === 'b') send({ type: 'blank', on: !snap.blanked });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snap, send]);

  if (auth === 'unauthorized') {
    return (
      <main className="gate">
        <h1>Open the private control link</h1>
        <p>This page controls what your stream shows, so it only opens from the link printed in the terminal where you ran <code>npm start</code>.</p>
        <p>The OBS overlay link is different and cannot control anything.</p>
      </main>
    );
  }
  if (!snap) {
    return <main className="gate"><p>{auth === 'checking' ? 'Opening…' : conn === 'closed' ? 'The overlay server is not reachable. Is it still running?' : 'Connecting…'}</p></main>;
  }

  const st = statusLine(snap);
  const listening = cap.listening;
  const d = snap.display;
  const lay = snap.layout && d.verse && snap.layout.key === d.verse.key ? snap.layout : null;

  return (
    <div className="control">
      <header className="topbar">
        <div className="brand">Quran Overlay</div>
        <div className={`status status-${st.tone}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden />
          <div>
            <div className="status-title">{st.title}</div>
            <div className="status-detail">{st.detail}</div>
          </div>
        </div>
        <div className="conn">{conn === 'open' ? `OBS/readers connected: ${snap.overlay.clients}` : 'Reconnecting to the local server…'}</div>
      </header>

      <main className="grid">
        <section className="monitor" aria-label="What the audience sees">
          <div className="monitor-head">
            <span className={`onair ${d.visible ? 'live' : ''}`}>{d.visible ? 'On screen' : snap.blanked ? 'Hidden from stream' : 'Nothing on screen'}</span>
            {snap.blanked && d.verse && <span className="muted">{d.verse.key} returns when you unhide</span>}
            {lay?.promotedToFullFrame && <span className="warn">Too long for the lower third — shown full frame</span>}
            <SpeedMeter view={speedView} listening={cap.listening} />
          </div>
          <div className="view-controls">
            <div className="reading-view" role="radiogroup" aria-label="Language">
              {([['both', 'Arabic + English'], ['arabic', 'Arabic'], ['english', 'English']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={d.style.language === value} className={d.style.language === value ? 'primary' : ''} onClick={() => send({ type: 'style', patch: { language: value } })}>{label}</button>)}
            </div>
            <div className="reading-view" role="radiogroup" aria-label="Reading view">
              {([['follow', 'Follow words'], ['word', 'Word focus'], ['ayah', 'Full ayah']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={d.style.readingMode === value} className={d.style.readingMode === value ? 'primary' : ''} disabled={value === 'word' && d.style.language === 'english'} title={value === 'word' && d.style.language === 'english' ? 'Word focus shows one Arabic word' : undefined} onClick={() => send({ type: 'style', patch: { readingMode: value } })}>{label}</button>)}
            </div>
          </div>
          <StageFrame className="preview">
            <VerseDisplay state={d} fontsReady={fontsReady} onLayout={onLayout} preview />
          </StageFrame>

          <div className="transport">
            <button onClick={() => send({ type: 'nav', action: 'prev' })} title="Previous ayah (←)">‹ Previous ayah</button>
            <button onClick={() => send({ type: 'nav', action: 'next' })} title="Next ayah (→)">Next ayah ›</button>
            <span className="sep" />
            {snap.held ? (
              <button className="primary" onClick={() => send({ type: 'hold', on: false })} title="Resume following (H)">Resume following</button>
            ) : (
              <button onClick={() => send({ type: 'hold', on: true })} title="Pause following (H)">Pause following</button>
            )}
            <button className={snap.blanked ? 'primary' : ''} onClick={() => send({ type: 'blank', on: !snap.blanked })} title="Hide or unhide the screen (B)">
              {snap.blanked ? 'Unhide' : 'Hide from stream'}
            </button>
          </div>

          {lay && (lay.englishPages > 1 || lay.arabicPages > 1) && (
            <div className="pager">
              {lay.arabicPages > 1 && (
                <span>
                  Arabic {d.arabicPage === null ? 'follows your recitation' : `part ${d.arabicPage + 1}/${lay.arabicPages}`}
                  <button onClick={() => send({ type: 'page', region: 'arabic', page: Math.max(0, (d.arabicPage ?? 0) - 1) })}>‹</button>
                  <button onClick={() => send({ type: 'page', region: 'arabic', page: Math.min(lay.arabicPages - 1, (d.arabicPage ?? 0) + 1) })}>›</button>
                  {d.arabicPage !== null && <button onClick={() => send({ type: 'arabic_auto' })}>Follow recitation</button>}
                </span>
              )}
              {lay.englishPages > 1 && (
                <span>
                  Translation page {(d.englishPage % lay.englishPages) + 1}/{lay.englishPages}
                  <button onClick={() => send({ type: 'page', region: 'english', page: (d.englishPage + lay.englishPages - 1) % lay.englishPages })}>‹</button>
                  <button onClick={() => send({ type: 'page', region: 'english', page: (d.englishPage + 1) % lay.englishPages })}>›</button>
                  <span className="muted">{d.style.translationPageSeconds ? `turns every ${d.style.translationPageSeconds} s` : 'manual'}</span>
                </span>
              )}
            </div>
          )}

          {snap.notice && <div className="notice">{snap.notice}</div>}

        </section>

        <aside className="side">
          <VoiceCard
            snap={snap}
            capture={capture}
            listening={listening}
            devices={devices}
            deviceId={deviceId}
            setDeviceId={setDeviceId}
            onStart={() => void cap.start(deviceId || null)}
            onStop={() => cap.stop()}
            chapters={chapters}
            send={send}
            credits={credits}
            query={query}
            setQuery={setQuery}
            pending={!!pendingId}
            result={result?.r ?? null}
            onSubmit={() => query.trim() && runCommand(query, 'typed')}
            onShow={(key) => result && send({ type: 'show_result', requestId: result.id, key })}
            onClear={() => {
              setResult(null);
              setQuery('');
              lastRequest.current = null;
            }}
          />
          <details className="diagnostics">
            <summary>What the tracker hears (private)</summary>
            <p className="heard" lang="ar" dir="rtl">
              {snap.heard.final} <span className="provisional">{snap.heard.provisional}</span>
            </p>
            <div className="diag-grid">
              <div>
                <h4>Candidates</h4>
                <ul>{snap.candidates.map((c) => <li key={c.key}>{c.key} · {c.relation} · score {c.score} · {c.matched} matched{c.trailing ? ` · ${c.trailing} unexplained` : ''}</li>)}</ul>
              </div>
              <div>
                <h4>Decisions ({snap.mode})</h4>
                <ul>{snap.decisions.map((x, i) => <li key={i}>{x.reason}: {x.outcome} · {x.latencyMs} ms{x.truncated ? ' · shortlist truncated' : ''}{x.changedOverlay ? ' · changed screen' : ''}</li>)}</ul>
                {!snap.decisions.length && <p className="muted">No decision requests yet.</p>}
              </div>
              <div>
                <h4>Timing (this session)</h4>
                <ul>
                  <li>Tracker update p50/p95: {snap.metrics.trackerP50Ms ?? '—'} / {snap.metrics.trackerP95Ms ?? '—'} ms ({snap.metrics.updates} updates)</li>
                  <li>Commit → OBS paint ack p50/p95: {snap.metrics.paintRttP50Ms ?? '—'} / {snap.metrics.paintRttP95Ms ?? '—'} ms</li>
                  <li>Decision calls: {snap.metrics.decisionCalls}{snap.metrics.decisionP50Ms !== null ? `, p50 ${snap.metrics.decisionP50Ms} ms` : ''}</li>
                </ul>
              </div>
            </div>
            <label className="row">
              Tracker mode (experiment)
              <select value={snap.mode} onChange={(e) => send({ type: 'mode', mode: e.target.value as ControlSnapshot['mode'] })}>
                <option value="hybrid">Hybrid — JEV only when unsure</option>
                <option value="deterministic">Deterministic — no JEV</option>
                <option value="jev_required">Experimental: wait for JEV at each ayah</option>
              </select>
            </label>
          </details>
          <details className="diagnostics">
            <summary>Quran resources ({snap.setup.resources.filter((r) => r.state === 'in use').length} in use)</summary>
            <ul className="resources">
              {snap.setup.resources.map((r) => (
                <li key={r.id}>
                  <strong>{r.title}</strong> <span className={`res-state res-${r.state.split(' ')[0]}`}>{r.state}</span>
                  {r.detail && <div className="muted">{r.detail}</div>}
                </li>
              ))}
            </ul>
          </details>
          <OutputCard
            snap={snap}
            send={send}
            copied={copied}
            onCopy={() => {
              void navigator.clipboard.writeText(snap.overlay.url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              });
            }}
          />
        </aside>
      </main>
    </div>
  );
}

/**
 * One place for everything spoken or typed: listening follows recitation and also hears English
 * requests ("go to Surah Maryam, ayah three"), typing does the same without the microphone, and the
 * results of either appear right here.
 */
function VoiceCard(p: {
  snap: ControlSnapshot;
  capture: CaptureStatus;
  listening: boolean;
  devices: MediaDeviceInfo[];
  deviceId: string;
  setDeviceId: (id: string) => void;
  onStart: () => void;
  onStop: () => void;
  chapters: ChapterRow[];
  send: (m: ControlClientMessage) => boolean;
  credits: CreditView | null;
  query: string;
  setQuery: (q: string) => void;
  pending: boolean;
  result: CommandResult | null;
  onSubmit: () => void;
  onShow: (key: string) => void;
  onClear: () => void;
}) {
  const [surah, setSurah] = useState<number | ''>(p.snap.startHint ? Number(p.snap.startHint.split(':')[0]) : '');
  const [ayah, setAyah] = useState<string>(p.snap.startHint ? p.snap.startHint.split(':')[1] : '');
  const ch = p.chapters.find((c) => c.number === surah);
  const starting = p.capture.state === 'starting' || p.capture.state === 'reconnecting';
  const r = p.result;
  // The last few heard words, so it is obvious the microphone is working (full view in diagnostics).
  const heard = `${p.snap.heard.final} ${p.snap.heard.provisional}`.trim().split(/\s+/).filter(Boolean).slice(-9).join(' ');
  return (
    <section className="card voice-card">
      <h2>Recite or ask</h2>
      {!p.snap.setup.soniox && (
        <p className="setup">Listening needs a Soniox key: add <code>SONIOX_API_KEY</code> to <code>.env</code> and restart the server. Typing, navigation and the overlay work without it.</p>
      )}
      <div className="listen-row">
        {p.listening || starting ? (
          <button className="big stop" onClick={p.onStop}>Stop listening</button>
        ) : (
          <button className="big go" onClick={p.onStart} disabled={!p.snap.setup.soniox}>Start listening</button>
        )}
        <select aria-label="Microphone" value={p.deviceId} onChange={(e) => p.setDeviceId(e.target.value)} disabled={p.listening || starting}>
          <option value="">Default microphone</option>
          {p.devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
          ))}
        </select>
      </div>
      {p.listening && (
        <div className="live-heard">
          <span className="live-dot" aria-hidden />
          {heard ? <span className="live-words"><span lang="ar">{heard}</span></span> : <span className="muted">Listening…</span>}
        </div>
      )}
      <p className="hint">
        {starting
          ? 'Connecting the microphone…'
          : p.capture.state === 'error'
            ? p.capture.detail
            : p.capture.state === 'dozing'
              ? 'Waiting for you to recite. After a long pause the microphone stays on here but nothing is sent (listening is billed while a stream is open); recite and it continues at once.'
              : p.listening
              ? 'Recite and the screen follows. Or just say it in English: “go to Surah Maryam, ayah three”, “show the ayah about the orphan”, or describe one to find it here privately. Other English talk never changes the screen.'
              : (p.capture.detail ?? 'One microphone for both: recite to follow, or speak an English request. Audio goes to Soniox only while you speak: long pauses send nothing, and listening stops by itself after a while without recitation.')}
      </p>

      {p.credits && (
        <p className={`credits-line${p.credits.available < 600 ? ' low' : ''}`}>
          {listeningLine(p.credits)}
        </p>
      )}
      <form
        className="find"
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit();
        }}
      >
        <input
          value={p.query}
          onChange={(e) => p.setQuery(e.target.value)}
          placeholder="Or type: 2:255, Surah Maryam ayah 3, or what it says"
          aria-label="Type a reference or what the ayah says"
        />
        <button type="submit" disabled={!p.query.trim()}>Go</button>
      </form>

      {p.pending && <p className="pending">Searching…</p>}
      {!p.pending && r?.kind === 'control' && <p className="ok">{r.label}</p>}
      {!p.pending && r?.kind === 'navigate' && <p className="ok">Opened {r.key}.{r.note ? ` ${r.note}` : ''} Recitation continues from there.</p>}
      {!p.pending && (r?.kind === 'no_match' || r?.kind === 'invalid_reference') && <p className="warn">{r.message}</p>}
      {!p.pending && r?.kind === 'candidates' && (
        <div className="results">
          <p className={r.refining ? 'pending' : 'hint'}>{r.status} Searches stay private until you choose Show on stream.</p>
          <ol>
            {r.cards.map((c) => (
              <ResultCard key={c.key} card={c} confirmed={c.key === r.confirmedKey} onShow={p.onShow} />
            ))}
          </ol>
          <button onClick={p.onClear}>Clear results</button>
        </div>
      )}
      {p.snap.held && (
        <button className="primary wide" onClick={() => p.send({ type: 'hold', on: false })}>Resume following from the screen</button>
      )}

      <details className="start-point">
        <summary>{p.snap.startHint ? `Starting point: near ${p.snap.startHint}` : 'Starting point (optional)'}</summary>
        <div className="start-from">
          <select aria-label="Starting surah" value={surah} onChange={(e) => setSurah(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Anywhere (find automatically)</option>
            {p.chapters.map((c) => (
              <option key={c.number} value={c.number}>{c.number}. {c.nameSimple}</option>
            ))}
          </select>
          <input aria-label="Starting ayah" inputMode="numeric" placeholder="ayah" value={ayah} onChange={(e) => setAyah(e.target.value.replace(/\D/g, ''))} disabled={!surah} />
          <button onClick={() => p.send({ type: 'start_hint', key: surah ? `${surah}:${Math.min(Math.max(1, Number(ayah) || 1), ch?.verseCount ?? 1)}` : null })}>Set</button>
        </div>
        <p className="hint">Helps when several surahs open the same way; other passages are still recognized.</p>
      </details>
    </section>
  );
}

function ResultCard({ card, confirmed, onShow }: { card: SearchCard; confirmed: boolean; onShow: (key: string) => void }) {
  const [shown, setShown] = useState<SearchCard>(card);
  // Reset the context view only when the card becomes a different ayah; a refined result (e.g. JEV's
  // pick arriving) must not undo browsing the user is doing on this card.
  useEffect(() => setShown(card), [card.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (key: string | null) => {
    if (!key) return;
    fetch(`/api/verse/${key}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: SearchCard | null) => c && setShown(c))
      .catch(() => undefined);
  };
  const offset = shown.key === card.key ? null : shown.key === card.prevKey ? 'Previous ayah' : 'Next ayah';
  return (
    <li className={`result ${confirmed ? 'confirmed' : ''}`}>
      <div className="result-head">
        <strong>{shown.surahName} {shown.key}</strong>
        {confirmed && shown.key === card.key && <span className="badge">Best match</span>}
        {offset && <span className="muted">{offset} (context)</span>}
      </div>
      <p className="result-ar" lang="ar" dir="rtl">{toQpcHafsEncoding(shown.arabic)}</p>
      <p className="result-en">{shown.english}</p>
      {shown.key === card.key && card.foundBy.length > 0 && <p className="found-by">Found by {card.foundBy.join(' · ')}</p>}
      <div className="result-actions">
        <button className="primary" onClick={() => onShow(shown.key)}>Show on stream</button>
        <button onClick={() => go(shown.key === card.nextKey ? card.key : card.prevKey)} disabled={shown.key === card.prevKey || !card.prevKey}>Earlier</button>
        <button onClick={() => go(shown.key === card.prevKey ? card.key : card.nextKey)} disabled={shown.key === card.nextKey || !card.nextKey}>Later</button>
      </div>
    </li>
  );
}

function OutputCard({ snap, send, copied, onCopy }: { snap: ControlSnapshot; send: (m: ControlClientMessage) => boolean; copied: boolean; onCopy: () => void }) {
  const s = snap.display.style;
  const seg = <T extends string>(label: string, value: T, options: Array<[T, string]>, onPick: (v: T) => void) => (
    <div className="seg" role="radiogroup" aria-label={label}>
      <span className="seg-label">{label}</span>
      {options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onPick(v)}>{text}</button>
      ))}
    </div>
  );
  return (
    <section className="card">
      <h2>Stream output</h2>
      <div className="copy-row">
        <button className="primary" onClick={onCopy}>{copied ? 'Copied' : 'Copy OBS overlay link'}</button>
        <a href={snap.overlay.url.replace('#view=', '#bg=solid&view=')} target="_blank" rel="noreferrer">Open reading screen</a>
      </div>
      <p className="hint">In OBS: Sources → + → Browser, paste the link, set 1920 × 1080. Leave “Shutdown source when not visible” off. The link can only show verses.</p>
      {seg('Layout', s.layout, [['fullframe', 'Full frame'], ['lowerthird', 'Lower third']], (v) => send({ type: 'style', patch: { layout: v } }))}
      {seg('Background', s.background, [['transparent', 'Transparent'], ['scrim', 'Shaded panel'], ['solid', 'Solid']], (v) => send({ type: 'style', patch: { background: v } }))}
      <div className="seg accent-row" role="radiogroup" aria-label="Colour">
        <span className="seg-label">Colour</span>
        {ACCENTS.map(([hex, name]) => (
          <button key={hex} role="radio" aria-checked={s.accent.toLowerCase() === hex} aria-label={name} title={name} className={`swatch${s.accent.toLowerCase() === hex ? ' on' : ''}`} style={{ background: hex }} onClick={() => send({ type: 'style', patch: { accent: hex } })} />
        ))}
        <label className={`swatch custom${ACCENTS.some(([h]) => h === s.accent.toLowerCase()) ? '' : ' on'}`} title="Your own colour">
          <input type="color" value={s.accent} aria-label="Your own colour" onChange={(e) => send({ type: 'style', patch: { accent: e.target.value } })} />
        </label>
      </div>
      <label className="row">
        <input type="checkbox" checked={s.credit} onChange={(e) => send({ type: 'style', patch: { credit: e.target.checked } })} /> Show a small “Quran Overlay by Nurra” in the corner
      </label>
      <label className="row">
        <input type="checkbox" checked={s.showReference} onChange={(e) => send({ type: 'style', patch: { showReference: e.target.checked } })} /> Show surah and ayah number
      </label>
      <label className="row">
        <input type="checkbox" checked={s.showNext} onChange={(e) => send({ type: 'style', patch: { showNext: e.target.checked } })} /> Show the next ayah, dimmed (full frame)
      </label>
      <label className="row">
        <input type="checkbox" checked={s.groupShort} onChange={(e) => send({ type: 'style', patch: { groupShort: e.target.checked } })} /> Show short ayahs together (full frame)
      </label>
      <label className="row">
        Arabic size
        <input type="range" min={0.8} max={1.25} step={0.05} value={s.arabicScale} onChange={(e) => send({ type: 'style', patch: { arabicScale: Number(e.target.value) } })} />
      </label>
      <label className="row">
        Long translations turn pages
        <select value={s.translationPageSeconds} onChange={(e) => send({ type: 'style', patch: { translationPageSeconds: Number(e.target.value) } })}>
          <option value={0}>only when I press ›</option>
          <option value={10}>every 10 s</option>
          <option value={14}>every 14 s</option>
          <option value={20}>every 20 s</option>
        </select>
      </label>
      <label className="row">
        When recitation stops matching
        <select value={snap.keepOnUncertain ? 'keep' : 'clear'} onChange={(e) => send({ type: 'uncertain_policy', keep: e.target.value === 'keep' })}>
          <option value="keep">keep the last ayah until the new one is found</option>
          <option value="clear">clear the screen after 3 s</option>
        </select>
      </label>
      <label className="row">
        <input type="checkbox" checked={snap.pinned} onChange={(e) => send({ type: 'pin', on: e.target.checked })} /> Keep the ayah up if the microphone disconnects
      </label>
      <button className="link" onClick={() => send({ type: 'rotate_view' })}>Replace overlay link (old links stop working)</button>
      <p className="fine">
        {snap.corpus.verses.toLocaleString()} ayahs · {snap.corpus.chapters} surahs · {snap.corpus.attribution}. Decisions: {snap.setup.jev.detail} Semantic search: {snap.setup.semantic}.
      </p>
      <p className="fine control-brand">
        <NurraBadge /> <a href="/about">How and why</a>
      </p>
    </section>
  );
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const secs = (ms: number | null) => (ms === null ? '—' : `${Math.max(0, ms / 1000).toFixed(1)} s`);

function SpeedMeter({ view, listening }: { view: { ayah: number[]; word: number[]; last: number | null }; listening: boolean }) {
  if (!listening && !view.ayah.length && !view.word.length) return null;
  return (
    <span className="speed" title="How far the screen trails your voice, measured after it paints. Microphone input latency is not included.">
      Behind your voice: ayah changes <strong>{secs(median(view.ayah))}</strong>
      {view.ayah.length ? ` (median of ${view.ayah.length}, last ${secs(view.last)})` : ''} · words <strong>{secs(median(view.word))}</strong>
    </span>
  );
}
