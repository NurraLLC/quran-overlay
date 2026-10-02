// The charity stream scene for OBS (/stream#view=…): the reader in its panel, framed in Nurra's
// colours, with the donations ("May Allah accept Aisha's donation"), what they are for, how to give
// and a window for the camera. Read-only, like the overlay: it receives the display and the stream's
// data from the streamer's session and acknowledges paints. Set up on the control page.

import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/700.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource/marcellus-sc/400.css';
import qrcode from 'qrcode-generator';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DisplayStateSchema, type DisplayState, type Donation, type OverlayServerMessage, type StreamState } from '../shared/contracts';
import { connect, u } from './net';
import { NurraWordmark } from './Nurra';
import { money, whose } from './stream-format';
import { NURRA_ENGLISH_FONT, NURRA_ENGLISH_WEIGHT, StageFrame, VerseDisplay, useFontsReady, type LayoutInfo } from './VerseDisplay';

/** How long a new donation is announced (gold) before the next one, or before it settles. */
const ANNOUNCE_MS = 8000;
/** The reader's panel inside the centre frame (the scene is 1920×1080; see .cs-* in app.css). */
const PANEL = { width: 832, height: 732 };
/** The camera's window in the arch: OBS shows the camera source placed under this page through it. */
const WINDOW = { left: 134, top: 172, width: 276, height: 348, radius: 138 };
const WINDOW_PATH = `M${WINDOW.left} ${WINDOW.top + WINDOW.radius} A${WINDOW.radius} ${WINDOW.radius} 0 0 1 ${WINDOW.left + WINDOW.width} ${WINDOW.top + WINDOW.radius} V${WINDOW.top + WINDOW.height - 5} Q${WINDOW.left + WINDOW.width} ${WINDOW.top + WINDOW.height} ${WINDOW.left + WINDOW.width - 5} ${WINDOW.top + WINDOW.height} H${WINDOW.left + 5} Q${WINDOW.left} ${WINDOW.top + WINDOW.height} ${WINDOW.left} ${WINDOW.top + WINDOW.height - 5} Z`;

function readView(): string | null {
  const params = new URLSearchParams(location.hash.slice(1));
  let view = params.get('view');
  try {
    if (view) sessionStorage.setItem('qo_stream_view', view);
    else view = sessionStorage.getItem('qo_stream_view');
  } catch {
    /* storage unavailable: the URL fragment still works */
  }
  return view;
}

function ago(at: number, now: number) {
  const m = Math.floor((now - at) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

function Star({ size, color = '#fff7b2' }: { size: number; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: 'block', flex: 'none' }}>
      <rect x="6" y="6" width="12" height="12" fill={color} />
      <rect x="6" y="6" width="12" height="12" fill={color} transform="rotate(45 12 12)" />
    </svg>
  );
}

/** Four small stars on a box's corners, as in the frame of a mushaf page. */
function Corners({ size }: { size: number }) {
  const o = -size / 2;
  return (
    <>
      {[{ left: o, top: o }, { right: o, top: o }, { left: o, bottom: o }, { right: o, bottom: o }].map((p, i) => (
        <span key={i} className="cs-corner" style={p}><Star size={size} /></span>
      ))}
    </>
  );
}

/** A QR code for the donation link (scannable from the screen: dark on paper, four modules of margin). */
function Qr({ text, size }: { text: string; size: number }) {
  const code = useMemo(() => {
    if (!text) return null;
    try {
      const q = qrcode(0, 'M');
      q.addData(text);
      q.make();
      const n = q.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return { n, d };
    } catch {
      return null;
    }
  }, [text]);
  if (!code) return null;
  const m = 4;
  return (
    <svg className="cs-qr" viewBox={`${-m} ${-m} ${code.n + 2 * m} ${code.n + 2 * m}`} width={size} height={size} role="img" aria-label="QR code to give" shapeRendering="crispEdges">
      <rect x={-m} y={-m} width={code.n + 2 * m} height={code.n + 2 * m} fill="#faf7eb" />
      <path d={code.d} fill="#041a3d" />
    </svg>
  );
}

export function Stream() {
  const [view] = useState(readView);
  const [display, setDisplay] = useState<DisplayState | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [denied, setDenied] = useState(false);
  const lastRevision = useRef(-1);
  const epoch = useRef<string | null>(null);
  const sock = useRef<ReturnType<typeof connect> | null>(null);

  useEffect(() => {
    document.documentElement.dataset.surface = 'overlay';
    document.title = 'Charity stream · Quran Reader';
    if (!view) {
      setDenied(true);
      return;
    }
    sock.current = connect(u('/ws/overlay'), {
      onOpen: (send) => send({ type: 'hello', view, role: 'overlay' }),
      onStatus: (status, code) => {
        if (status !== 'closed' || code !== 4410) return;
        epoch.current = null;
        lastRevision.current = -1;
        setDisplay(null);
        setDenied(false);
      },
      shouldRetry: (code) => code !== 4401,
      onMessage: (data) => {
        const m = data as OverlayServerMessage;
        if (m.type === 'denied') return setDenied(true);
        if (m.type === 'stream') return setStream(m.state);
        if (m.type !== 'display') return;
        const parsed = DisplayStateSchema.safeParse(m.state);
        if (!parsed.success) return;
        const s = parsed.data;
        if (s.sessionEpoch === epoch.current && s.revision <= lastRevision.current) return;
        epoch.current = s.sessionEpoch;
        lastRevision.current = s.revision;
        setDenied(false);
        setDisplay(s);
      },
    });
    return () => sock.current?.close();
  }, [view]);

  const onPaint = useCallback((revision: number) => { sock.current?.send({ type: 'painted', revision }); }, []);

  useEffect(() => {
    if (denied) console.warn('Quran Reader: this stream link is missing or was replaced. Copy the current one from the control page (Charity stream).');
  }, [denied]);

  if (denied || !stream) return null;
  return <StageFrame className="overlay-frame"><StreamScene display={display} stream={stream} onPaint={onPaint} /></StageFrame>;
}

/** The actual scene, shared by OBS and the broadcaster preview; it opens no viewer or audio socket. */
export function StreamScene({ display, stream, onLayout, onPaint }: {
  display: DisplayState | null; stream: StreamState; onLayout?: (info: LayoutInfo) => void; onPaint?: (revision: number) => void;
}) {
  const id = useId();
  const [now, setNow] = useState(() => Date.now());
  const fontsReady = useFontsReady(NURRA_ENGLISH_FONT, NURRA_ENGLISH_WEIGHT);
  // The scene appears once its own lettering is loaded (never a flash of a fallback face on stream);
  // a font that fails to load does not hold it back for more than a moment.
  const [letteringReady, setLetteringReady] = useState(false);
  useEffect(() => {
    let alive = true;
    const done = () => alive && setLetteringReady(true);
    const t = setTimeout(done, 3000);
    Promise.all(['20px "Marcellus SC"', '700 34px "Cormorant Garamond"', 'italic 500 28px "Cormorant Garamond"', '600 32px "Cormorant Garamond"'].map((f) => document.fonts.load(f))).then(done, done);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);
  // Donations are announced one at a time, oldest first; ones already there when the page opened are not.
  const seen = useRef<Set<string> | null>(null);
  const [queue, setQueue] = useState<Donation[]>([]);
  const [announcing, setAnnouncing] = useState<Donation | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!stream) return;
    const ids = new Set(stream.donations.map((d) => d.id));
    if (seen.current === null) {
      seen.current = ids;
      return;
    }
    const fresh = stream.donations.filter((d) => !seen.current!.has(d.id)).reverse();
    for (const d of fresh) seen.current.add(d.id);
    // A donation taken back (a mistake) is not announced, or stops being.
    setQueue((q) => [...q.filter((d) => ids.has(d.id)), ...fresh]);
    setAnnouncing((a) => (a && !ids.has(a.id) ? null : a));
  }, [stream]);

  useEffect(() => {
    if (!announcing && queue.length) {
      setAnnouncing(queue[0]);
      setQueue((q) => q.slice(1));
    }
  }, [announcing, queue]);

  useEffect(() => {
    if (!announcing) return;
    const t = setTimeout(() => setAnnouncing(null), ANNOUNCE_MS);
    return () => clearTimeout(t);
  }, [announcing]);

  useEffect(() => {
    if (!display || !fontsReady || !letteringReady || !onPaint) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => { timer = setTimeout(() => onPaint(display.revision), 0); });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [display, fontsReady, letteringReady, onPaint]);

  if (!letteringReady) return null;
  const s = stream.settings;
  const camera = s.camera;
  // The slot shows the donation being announced, or (settled) the latest one.
  const slot = announcing ?? stream.donations[0] ?? null;
  // Room for three more, or two when the slot also carries the donor's own words.
  const others = stream.donations.filter((d) => d.id !== slot?.id).slice(0, slot?.message ? 2 : 3);
  const totalText = money(stream.total, s.currency);
  const slotName = slot ? whose(slot.name) : '';
  const progress = s.goal > 0 ? Math.min(1, stream.total / s.goal) : null;
  const elapsed = s.startedAt !== null ? now - s.startedAt : -1;
  const hour = elapsed >= 0 ? Math.min(s.hours, Math.floor(elapsed / 3600_000) + 1) : null;
  const linkLabel = s.link.replace(/^https:\/\//, '').replace(/\/$/, '');
  const project = s.project ? `${s.project}${s.country ? ` in ${s.country}` : ''}` : s.country;

  return (
      <div className="cs-scene" data-camera={camera || undefined}>
        {/* With a camera, the scene's ground is painted around the arch's window (a spread shadow),
            so the camera source under this page in OBS shows through it. */}
        {camera && <div className="cs-hole" style={{ left: WINDOW.left, top: WINDOW.top, width: WINDOW.width, height: WINDOW.height, borderRadius: `${WINDOW.radius}px ${WINDOW.radius}px 5px 5px` }} />}
        <div className="cs-glow" />
        <svg className="cs-pattern" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden="true">
          <defs>
            <pattern id={`cs-khatam-${id}`} width="120" height="120" patternUnits="userSpaceOnUse">
              <rect x="42" y="42" width="36" height="36" fill="none" stroke="#fff7b2" strokeWidth="1" />
              <rect x="42" y="42" width="36" height="36" fill="none" stroke="#fff7b2" strokeWidth="1" transform="rotate(45 60 60)" />
              <path d="M0 60 H24 M96 60 H120 M60 0 V24 M60 96 V120" stroke="#fff7b2" strokeWidth="1" />
            </pattern>
            <mask id={`cs-window-${id}`}>
              <rect width="1920" height="1080" fill="white" />
              {camera && <path d={WINDOW_PATH} fill="black" />}
            </mask>
          </defs>
          <rect width="1920" height="1080" fill={`url(#cs-khatam-${id})`} opacity="0.07" mask={`url(#cs-window-${id})`} />
        </svg>
        <div className="cs-frame cs-frame-outer" />
        <div className="cs-frame cs-frame-inner" />
        {[{ left: 8, top: 8 }, { right: 8, top: 8 }, { left: 8, bottom: 8 }, { right: 8, bottom: 8 }].map((p, i) => (
          <span key={i} className="cs-corner" style={p}><Star size={24} /></span>
        ))}

        <header className="cs-header">
          <span className="cs-live"><span className="cs-live-dot" />Live</span>
          <span className="cs-rule" />
          <Star size={18} />
          <div className="cs-title">
            <span className="cs-title-main">{s.title || 'Twenty-four hours of Quran'}</span>
            {s.partner && <span className="cs-title-for">for {s.partner}</span>}
          </div>
          <Star size={18} />
          <span className="cs-rule" />
          <span className="cs-hour">{hour !== null ? `Hour ${hour} of ${s.hours}` : ''}</span>
        </header>

        <div className="cs-arch">
          <div className={`cs-arch-window${camera ? '' : ' cs-arch-closed'}`}>
            {!camera && (s.photo ? <img className="cs-arch-photo" src={s.photo} alt="" /> : <span className="cs-arch-star"><Star size={120} color="rgba(255, 247, 178, 0.18)" /></span>)}
            {s.reciter && <div className="cs-nameplate">{s.reciter}</div>}
          </div>
        </div>

        <section className="cs-project" aria-label="What your giving does">
          <div className={`cs-project-inner${s.photo ? '' : ' cs-project-text'}`}>
            {s.photo && (
              <div className="cs-photo">
                <img src={s.photo} alt="" />
              </div>
            )}
            <span className="cs-label">What your giving does</span>
            {project && <span className="cs-project-title">{project}</span>}
            {s.about && <span className="cs-project-about">{s.about}</span>}
          </div>
          <Corners size={16} />
        </section>

        <div className="cs-reader">
          <div className="cs-reader-inner">
            {/* Before the first ayah (or while it is hidden): a quiet star, never an empty box. */}
            <span className={`cs-reader-idle${display?.verse && display.visible ? ' cs-reader-idle-off' : ''}`}><Star size={150} color="rgba(255, 247, 178, 0.14)" /></span>
            {display && <VerseDisplay state={display} fontsReady={fontsReady} frame={PANEL} theme="nurra" onLayout={onLayout} />}
          </div>
          <Corners size={20} />
        </div>

        <aside className="cs-giving" aria-label="Donations">
          <div className="cs-total">
            <span className="cs-label cs-muted">{s.partner ? `Raised for ${s.partner}` : 'Raised so far'}</span>
            <span className="cs-total-amount" style={{ fontSize: totalText.length > 10 ? 64 : totalText.length > 8 ? 80 : 96 }}>{totalText}</span>
            {progress !== null && (
              <div className="cs-progress" style={{ ['--p' as string]: progress }}>
                <span className="cs-progress-track" />
                <span className="cs-progress-fill" />
                <span className="cs-progress-star"><Star size={16} /></span>
              </div>
            )}
            <span className="cs-total-note">{progress !== null ? `of the ${money(s.goal, s.currency)} goal · ` : ''}{stream.count} {stream.count === 1 ? 'donor' : 'donors'}</span>
          </div>

          {slot ? (
            <div className={`cs-slot${announcing ? ' cs-slot-new' : ''}`} key={slot.id} aria-live="polite">
              <span className="cs-slot-line" />
              <span className="cs-label cs-slot-label">May Allah accept</span>
              <span className="cs-slot-name" style={{ fontSize: slotName.length > 34 ? 32 : slotName.length > 22 ? 40 : 50 }}>{slotName}</span>
              {slot.message && <span className="cs-slot-words">“{slot.message}”</span>}
              <span className="cs-slot-when">{s.showAmounts && slot.amount > 0 ? `${money(slot.amount, s.currency)} · ` : ''}{announcing ? 'just now' : ago(slot.at, now)}</span>
              <Corners size={18} />
            </div>
          ) : (
            <div className="cs-slot cs-slot-empty">
              <span className="cs-slot-line" />
              <span className="cs-label cs-slot-label">Be the first to give</span>
              <span className="cs-slot-when">May Allah accept it from you</span>
              <Corners size={18} />
            </div>
          )}

          {others.length > 0 && (
            <div className="cs-recent">
              <span className="cs-label cs-muted">May Allah accept from</span>
              {others.map((d) => (
                <div className="cs-recent-row" key={d.id}>
                  <span className={d.name ? 'cs-recent-name' : 'cs-recent-name cs-anon'}>{d.name || 'Anonymous'}</span>
                  <span className="cs-recent-when">{s.showAmounts && d.amount > 0 ? `${money(d.amount, s.currency)} · ` : ''}{ago(d.at, now)}</span>
                </div>
              ))}
            </div>
          )}

          {s.link && (
            <div className="cs-give">
              <span className="cs-give-qr"><Qr text={s.link} size={124} /></span>
              <div className="cs-give-text">
                <span className="cs-give-now">Give now</span>
                <span className="cs-give-link">{linkLabel}</span>
                {s.partner && <span className="cs-give-note">It goes straight to {s.partner}</span>}
              </div>
            </div>
          )}
        </aside>

        <footer className="cs-footer">
          <span className="cs-footer-by">Quran Reader by</span>
          <span className="cs-footer-mark"><NurraWordmark height={30} /></span>
          <Star size={12} />
          <span className="cs-footer-url">Follow along on your phone at <b>nurra.org/quran-reader</b></span>
          <span className="cs-footer-note">The highlight follows the recitation, word by word</span>
        </footer>
      </div>
  );
}
