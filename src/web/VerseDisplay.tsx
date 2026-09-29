// One renderer for the OBS overlay, the reading screen and the control preview. It lays out a
// fixed 1920×1080 stage, measures real line boxes with the loaded fonts, and either fits the verse
// or pages it deliberately (with visible continuation), never clipping or shrinking below the
// legibility floor. Arabic, translation and reference change together in one commit.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DisplayState } from '../shared/contracts';
import { toQpcHafsEncoding } from '../shared/display-encoding';

export const STAGE_W = 1920;
export const STAGE_H = 1080;

export const ARABIC_FONT = "'Uthmanic Hafs', serif";
export const ENGLISH_FONT = "'Charter', 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif";

export type LayoutInfo = {
  key: string;
  englishPages: number;
  arabicPages: number;
  promotedToFullFrame: boolean;
  arabicPx: number;
  englishPx: number;
};

type Lines = string[][];

let measureRoot: HTMLDivElement | null = null;

function measureLines(words: string[], font: string, px: number, lineHeight: number, width: number, rtl: boolean): Lines {
  if (!measureRoot) {
    measureRoot = document.createElement('div');
    measureRoot.setAttribute('aria-hidden', 'true');
    Object.assign(measureRoot.style, { position: 'absolute', left: '-40000px', top: '0', visibility: 'hidden', whiteSpace: 'normal', pointerEvents: 'none' });
    document.body.appendChild(measureRoot);
  }
  const r = measureRoot;
  r.style.width = `${width}px`;
  r.style.fontFamily = font;
  r.style.fontSize = `${px}px`;
  r.style.lineHeight = String(lineHeight);
  r.style.direction = rtl ? 'rtl' : 'ltr';
  r.lang = rtl ? 'ar' : 'en';
  r.textContent = '';
  const spans: HTMLSpanElement[] = [];
  words.forEach((w, i) => {
    const s = document.createElement('span');
    s.textContent = w;
    r.appendChild(s);
    spans.push(s);
    if (i < words.length - 1) r.appendChild(document.createTextNode(' '));
  });
  const lines: Lines = [];
  let lastTop = -Infinity;
  for (let i = 0; i < spans.length; i++) {
    const top = spans[i].offsetTop;
    if (top > lastTop + px * 0.3) {
      lines.push([]);
      lastTop = top;
    }
    lines[lines.length - 1].push(words[i]);
  }
  return lines;
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += Math.max(1, n)) out.push(xs.slice(i, i + Math.max(1, n)));
  return out.length ? out : [[]];
}

/** No-break space: binds an ayah-end ornament to the word before it. */
const NBSP = String.fromCharCode(0xa0);
const AR_LH = 1.95;
const EN_LH = 1.42;

type Plan = {
  layout: 'fullframe' | 'lowerthird';
  promoted: boolean;
  arabicPx: number;
  englishPx: number;
  arabicPages: Lines[];
  englishPages: Lines[];
  arabicPageWordStarts: number[];
  /** The dimmed next-ayah line: its first measured line, and whether the ayah continues past it. */
  next: { px: number; words: string[]; cut: boolean; lang: 'ar' | 'en' } | null;
  /** Short-ayah passage: for each Arabic word, which grouped ayah it belongs to, its index in that
   *  ayah, and (on an ayah's last word) the end ornament bound to it. null = the current ayah alone. */
  wordMeta: Array<{ ayah: number; index: number; mark?: string }> | null;
  /** English-only: for each English word, its grouped ayah and (on the last word) its ornament. */
  enMeta: Array<{ ayah: number; mark?: string }> | null;
  /** Several short ayahs share the screen (Arabic or English). */
  passage: boolean;
};

type Geometry = { width: number; height: number; refH: number; gap: number };

const FULL: Geometry = { width: 1560, height: 812, refH: 64, gap: 34 };
const LOWER: Geometry = { width: 1600, height: 318, refH: 48, gap: 16 };
/** Height kept for the next-ayah preview (hairline, optional surah label, one Arabic line). */
const NEXT_H = 160;
const NEXT_W = 1480;

function planFor(state: DisplayState, useGroup = true): Plan | null {
  const v = state.verse;
  if (!v) return null;
  if (state.style.language === 'english') return planEnglish(state, useGroup);
  const scale = state.style.arabicScale;
  const group = useGroup && state.group && state.group.length > 1 && state.style.readingMode !== 'word' ? state.group : null;
  let arWords = toQpcHafsEncoding(v.arabic).split(/\s+/).filter(Boolean);
  let wordMeta: Plan['wordMeta'] = null;
  if (group) {
    // One continuous passage, each ayah closed by its numbered ornament, as on a mushaf line.
    arWords = [];
    wordMeta = [];
    // The ornament is bound to the ayah's last word (no-break space) so a line never starts with it.
    group.forEach((g, gi) => {
      const ws = toQpcHafsEncoding(g.arabic).split(/\s+/).filter(Boolean);
      ws.forEach((w, wi) => {
        const mark = wi === ws.length - 1 ? arabicNumber(g.ayah) : undefined;
        arWords.push(mark ? `${w}${NBSP}${mark}` : w);
        wordMeta!.push({ ayah: gi, index: wi, mark });
      });
    });
  }
  const enWords = state.style.language === 'both' ? v.english.split(/\s+/).filter(Boolean) : [];

  const tryFit = (g: Geometry, arMax: number, arMin: number, enMax: number, enMin: number) => {
    for (let a = arMax; a >= arMin; a -= 2) {
      const e = Math.max(enMin, Math.min(enMax, Math.round(a * 0.5)));
      const al = measureLines(arWords, ARABIC_FONT, a, AR_LH, g.width, true);
      const el = enWords.length ? measureLines(enWords, ENGLISH_FONT, e, EN_LH, g.width, false) : [];
      const h = al.length * a * AR_LH + (el.length ? g.gap + el.length * e * EN_LH : 0) + g.refH;
      if (h <= g.height) return { a, e, al, el };
    }
    return null;
  };
  const nextLine = (a: number): Plan['next'] => {
    const n = state.next;
    if (!n) return null;
    const px = Math.max(40, Math.min(54, Math.round(a * 0.52)));
    // The end-of-ayah ornament closes the preview when the whole ayah fits on the line.
    const words = [...toQpcHafsEncoding(n.arabic).split(/\s+/).filter(Boolean), arabicNumber(n.ayah)];
    const lines = measureLines(words, ARABIC_FONT, px, AR_LH, NEXT_W, true);
    return { px, words: lines[0] ?? [], cut: lines.length > 1, lang: 'ar' };
  };
  const single = (fit: { a: number; e: number; al: Lines; el: Lines }, layout: Plan['layout'], promoted: boolean, next: Plan['next'] = null): Plan => ({
    layout,
    promoted,
    arabicPx: fit.a,
    englishPx: fit.e,
    arabicPages: [fit.al],
    englishPages: [fit.el],
    arabicPageWordStarts: [0],
    next,
    wordMeta,
    enMeta: null,
    passage: !!wordMeta,
  });

  if (state.style.layout === 'lowerthird' && state.style.readingMode !== 'word') {
    if (group) return planFor(state, false);
    const fit = tryFit(LOWER, Math.round(62 * scale), Math.round(46 * scale), 30, 26);
    if (fit) return single(fit, 'lowerthird', false);
  }
  const promoted = state.style.layout === 'lowerthird';
  // The preview only takes space the current ayah can spare at a comfortable size.
  if (state.next && state.style.readingMode !== 'word') {
    const withNext = tryFit({ ...FULL, height: FULL.height - NEXT_H }, Math.round(108 * scale), Math.round(64 * scale), 44, 31);
    if (withNext) return single(withNext, 'fullframe', promoted, nextLine(withNext.a));
  }
  // A passage of short ayahs is only worth it at a comfortable size; otherwise show the ayah alone.
  const fit = tryFit(FULL, Math.round(108 * scale), Math.round((group ? 64 : 54) * scale), 44, 31);
  if (fit) return single(fit, 'fullframe', promoted);
  if (group) return planFor(state, false);

  // Deliberate paging: fixed comfortable sizes; Arabic and translation page independently.
  const a = Math.round(58 * scale);
  const e = 32;
  const al = measureLines(arWords, ARABIC_FONT, a, AR_LH, FULL.width, true);
  const el = enWords.length ? measureLines(enWords, ENGLISH_FONT, e, EN_LH, FULL.width, false) : [];
  const body = FULL.height - FULL.refH - (el.length ? FULL.gap : 0);
  const arShare = el.length ? 0.54 : 1;
  const arLinesPerPage = Math.max(1, Math.floor((body * arShare) / (a * AR_LH)));
  const enLinesPerPage = Math.max(1, Math.floor((body - Math.min(al.length, arLinesPerPage) * a * AR_LH) / (e * EN_LH)));
  const arabicPages = chunk(al, arLinesPerPage);
  const starts: number[] = [];
  let count = 0;
  for (const p of arabicPages) {
    starts.push(count);
    count += p.reduce((n, l) => n + l.length, 0);
  }
  return {
    layout: 'fullframe',
    promoted,
    arabicPx: a,
    englishPx: e,
    arabicPages,
    englishPages: el.length ? chunk(el, enLinesPerPage) : [[]],
    arabicPageWordStarts: starts,
    next: null,
    wordMeta: null,
    enMeta: null,
    passage: false,
  };
}

const EN_ONLY_MAX = 76;
const EN_ONLY_MIN = 40;

/**
 * English only: the translation is the text being read, so it gets the stage. Short ayahs share the
 * screen as in Arabic, each closed by its numbered ornament.
 */
function planEnglish(state: DisplayState, useGroup: boolean): Plan {
  const v = state.verse!;
  const group = useGroup && state.group && state.group.length > 1 ? state.group : null;
  const measureWords: string[] = [];
  const enMeta: NonNullable<Plan['enMeta']> = [];
  (group ?? [{ key: v.key, ayah: v.ayah, arabic: v.arabic, english: v.english }]).forEach((g, gi) => {
    const ws = g.english.split(/\s+/).filter(Boolean);
    ws.forEach((w, wi) => {
      const mark = group && wi === ws.length - 1 ? arabicNumber(g.ayah) : undefined;
      // The ornament is drawn by the Arabic font and is about two letters wide.
      measureWords.push(mark ? `${w}${NBSP}MM` : w);
      enMeta.push({ ayah: gi, mark });
    });
  });
  const lower = state.style.layout === 'lowerthird';
  const fit = (g: Geometry, height: number, max: number, min: number) => {
    for (let e = max; e >= min; e -= 2) {
      const lines = measureLines(measureWords, ENGLISH_FONT, e, EN_LH, g.width, false);
      if (lines.length * e * EN_LH + g.refH <= height) return { e, lines };
    }
    return null;
  };
  const nextLine = (e: number): Plan['next'] => {
    const n = state.next;
    if (!n) return null;
    const px = Math.max(28, Math.min(40, Math.round(e * 0.6)));
    const lines = measureLines(n.english.split(/\s+/).filter(Boolean), ENGLISH_FONT, px, EN_LH, NEXT_W, false);
    return { px, words: lines[0] ?? [], cut: lines.length > 1, lang: 'en' };
  };
  const plan = (layout: Plan['layout'], e: number, pages: Lines[], next: Plan['next']): Plan => ({
    layout,
    promoted: lower && layout === 'fullframe',
    arabicPx: 0,
    englishPx: e,
    arabicPages: [[]],
    englishPages: pages,
    arabicPageWordStarts: [0],
    next,
    wordMeta: null,
    enMeta,
    passage: !!group,
  });
  if (lower && !group) {
    const f = fit(LOWER, LOWER.height, 44, 30);
    if (f) return plan('lowerthird', f.e, [f.lines], null);
  }
  if (lower && group) return planEnglish(state, false);
  if (state.next) {
    const f = fit(FULL, FULL.height - NEXT_H, EN_ONLY_MAX, group ? 48 : 44);
    if (f) return plan('fullframe', f.e, [f.lines], nextLine(f.e));
  }
  const f = fit(FULL, FULL.height, EN_ONLY_MAX, group ? 48 : EN_ONLY_MIN);
  if (f) return plan('fullframe', f.e, [f.lines], null);
  if (group) return planEnglish(state, false);
  const lines = measureLines(measureWords, ENGLISH_FONT, EN_ONLY_MIN, EN_LH, FULL.width, false);
  const perPage = Math.max(1, Math.floor((FULL.height - FULL.refH) / (EN_ONLY_MIN * EN_LH)));
  return plan('fullframe', EN_ONLY_MIN, chunk(lines, perPage), null);
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const arabicNumber = (n: number) => String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);

export function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all([document.fonts.load(`64px ${ARABIC_FONT}`, 'بسم'), document.fonts.load(`32px ${ENGLISH_FONT}`, 'In the name')])
      .catch(() => undefined)
      .then(() => document.fonts.ready)
      .then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

export function VerseDisplay({
  state,
  fontsReady,
  onLayout,
  preview = false,
}: {
  state: DisplayState;
  fontsReady: boolean;
  onLayout?: (info: LayoutInfo) => void;
  preview?: boolean;
}) {
  const v = state.verse;
  const lastFocus = useRef<{ key: string; text: string } | null>(null);
  useLayoutEffect(() => {
    if (v && state.cursor) lastFocus.current = { key: v.key, text: toQpcHafsEncoding(v.arabic).split(/\s+/).filter(Boolean).slice(state.cursor.from, state.cursor.to + 1).join(' ') };
  }, [v?.key, state.cursor?.from, state.cursor?.to]);
  const planKey = v ? `${v.key}|${state.group?.map((g) => g.key).join(',')}|${state.next?.key}|${state.style.layout}|${state.style.readingMode}|${state.style.arabicScale}|${state.style.language}` : '';
  // Layout is computed synchronously from measured line boxes before paint.
  const plan = useMemo(() => (fontsReady && v ? planFor(state) : null), [planKey, fontsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reading forward: when the new ayah is the one that was previewed, it rises out of the preview
  // line into place (a teleprompter scroll); any other change (jump, search) simply cuts.
  // A passage of short ayahs stays in place while the highlight moves through it: the article is
  // keyed by the passage, and only a new passage (or single ayah) arrives.
  const firstKey = plan?.passage && state.group ? state.group[0].key : (v?.key ?? null);
  const articleKey = plan?.passage && state.group ? `group:${firstKey}` : firstKey;
  const flow = useRef<{ key: string | null; nextKey: string | null; arrived: boolean }>({ key: null, nextKey: null, arrived: false });
  if (articleKey !== flow.current.key) flow.current = { key: articleKey, nextKey: state.next?.key ?? null, arrived: !!firstKey && firstKey === flow.current.nextKey };
  else if (state.next) flow.current.nextKey = state.next.key;

  const lastReported = useRef('');
  useLayoutEffect(() => {
    if (!plan || !v || !onLayout) return;
    const info: LayoutInfo = {
      key: v.key,
      englishPages: plan.englishPages.length,
      arabicPages: plan.arabicPages.length,
      promotedToFullFrame: plan.promoted,
      arabicPx: plan.arabicPx,
      englishPx: plan.englishPx,
    };
    const k = JSON.stringify(info) + state.revision;
    if (k !== lastReported.current) {
      lastReported.current = k;
      onLayout(info);
    }
  });

  if (!fontsReady) return <div className="stage" data-bg={state.style.background} data-empty="true" />;
  const visible = state.visible && !!plan && !!v;

  let arabicPage = 0;
  let englishPage = 0;
  if (plan && v) {
    const nA = plan.arabicPages.length;
    if (state.arabicPage !== null) arabicPage = Math.min(state.arabicPage, nA - 1);
    else if (state.cursor && nA > 1) {
      for (let i = 0; i < nA; i++) if (plan.arabicPageWordStarts[i] <= state.cursor.from) arabicPage = i;
    } else if (state.progress !== null && nA > 1) {
      const total = plan.arabicPageWordStarts[nA - 1] + plan.arabicPages[nA - 1].reduce((n, l) => n + l.length, 0);
      const word = Math.floor(state.progress * total);
      for (let i = 0; i < nA; i++) if (plan.arabicPageWordStarts[i] <= word) arabicPage = i;
    }
    englishPage = state.englishPage % plan.englishPages.length;
    // English only: a translation that needs pages follows recitation progress through the ayah.
    if (state.style.language === 'english' && plan.englishPages.length > 1 && state.englishPage === 0 && state.progress !== null)
      englishPage = Math.min(plan.englishPages.length - 1, Math.floor(state.progress * plan.englishPages.length));
  }

  const layout = plan?.layout ?? state.style.layout;
  const lang = state.style.language;
  // Word focus shows one Arabic word; with English only it reads as follow.
  const mode = lang === 'english' && state.style.readingMode === 'word' ? 'follow' : (state.style.readingMode ?? 'follow');
  const displayWords = v ? toQpcHafsEncoding(v.arabic).split(/\s+/).filter(Boolean) : [];
  const currentInGroup = plan?.passage && state.group && v ? state.group.findIndex((g) => g.key === v.key) : 0;
  const relOf = (ayah: number) => (ayah < currentInGroup ? 'past' : ayah > currentInGroup ? 'future' : 'current');
  // The reciter has reached the last word: what comes next brightens (preview line or next ayah in the passage).
  const anticipating = !!state.cursor && state.cursor.to >= displayWords.length - 1;
  const focusText = state.cursor ? displayWords.slice(state.cursor.from, state.cursor.to + 1).join(' ') : lastFocus.current?.key === v?.key ? lastFocus.current?.text : null;
  return (
    <div className="stage" data-bg={state.style.background} data-layout={layout} data-reading={mode} data-lang={lang} data-preview={preview || undefined}>
      <div className={`panel ${visible ? 'panel-on' : 'panel-off'}`} aria-hidden={!visible}>
        {visible && plan && v && (
          <article className={`verse${flow.current.arrived ? ' arrive' : ''}${plan.passage ? ' passage' : ''}`} key={articleKey ?? v.key} aria-label={`${v.surahName} ${v.key}`}>
            {lang !== 'english' && <div className={`arabic ${mode === 'word' ? 'word-focus' : ''}`} lang="ar" dir="rtl" style={{ fontSize: mode === 'word' ? 128 * state.style.arabicScale : plan.arabicPx }}>
              {mode === 'word' ? (
                <div className="focus-word" data-active={!!state.cursor}>
                  {focusText || <span className="focus-wait" lang="en" dir="ltr">Ready to follow</span>}
                </div>
              ) : plan.arabicPages[arabicPage].map((line, i) => (
                <div className="line" key={i}>
                  {line.map((word, j) => {
                    const index = plan.arabicPageWordStarts[arabicPage] + plan.arabicPages[arabicPage].slice(0, i).reduce((n, l) => n + l.length, 0) + j;
                    const meta = plan.wordMeta?.[index];
                    const rel = !meta ? 'current' : meta.ayah < currentInGroup ? 'past' : meta.ayah > currentInGroup ? 'future' : 'current';
                    const w = meta ? meta.index : index;
                    const active = mode === 'follow' && rel === 'current' && w >= 0 && !!state.cursor && w >= state.cursor.from && w <= state.cursor.to;
                    const passed = mode === 'follow' && rel === 'current' && w >= 0 && !!state.cursor && w < state.cursor.from;
                    const upNext = anticipating && !!meta && meta.ayah === currentInGroup + 1;
                    const cls = `quran-word${meta ? ` ayah-${rel}${upNext ? ' ayah-upnext' : ''}` : ''}${active ? ' active-word' : ''}${passed ? ' passed-word' : ''}`;
                    const text = meta?.mark ? word.slice(0, word.length - meta.mark.length - 1) : word;
                    return (
                      <span key={index}>
                        <span className={cls} data-word-index={w} aria-current={active ? 'true' : undefined}>{text}</span>
                        {meta?.mark && <>{NBSP}<span className={`quran-word ayah-${rel}${upNext ? ' ayah-upnext' : ''} ayah-mark`}>{meta.mark}</span></>}
                        {j < line.length - 1 ? ' ' : ''}
                      </span>
                    );
                  })}
                </div>
              ))}
              {mode !== 'word' && plan.arabicPages.length > 1 && (
                <div className="cont cont-ar" aria-label={`Arabic part ${arabicPage + 1} of ${plan.arabicPages.length}`}>
                  {arabicPage < plan.arabicPages.length - 1 ? 'continues' : 'end of ayah'} · {arabicPage + 1}/{plan.arabicPages.length}
                </div>
              )}
            </div>}
            {lang !== 'arabic' && plan.englishPages[englishPage].length > 0 && (
              <div className={`english${lang === 'english' ? ' english-only' : ''}`} lang="en" style={{ fontSize: plan.englishPx }}>
                {mode === 'word' && <div className="translation-label">Ayah translation</div>}
                {plan.englishPages[englishPage].map((line, i) => {
                  if (!plan.enMeta) return <div className="line" key={i}>{line.join(' ')}</div>;
                  const start = plan.englishPages.slice(0, englishPage).reduce((n, pg) => n + pg.reduce((m, l) => m + l.length, 0), 0) + plan.englishPages[englishPage].slice(0, i).reduce((n, l) => n + l.length, 0);
                  return (
                    <div className="line" key={i}>
                      {line.map((word, j) => {
                        const meta = plan.enMeta![start + j];
                        const rel = plan.passage ? relOf(meta.ayah) : 'current';
                        const upNext = anticipating && plan.passage && meta.ayah === currentInGroup + 1;
                        const cls = `en-word ayah-${rel}${upNext ? ' ayah-upnext' : ''}`;
                        return (
                          <span key={j}>
                            <span className={cls}>{meta.mark ? word.split(NBSP)[0] : word}</span>
                            {meta.mark && <>{NBSP}<span className={`${cls} ayah-mark en-mark`} lang="ar">{meta.mark}</span></>}
                            {j < line.length - 1 ? ' ' : ''}
                          </span>
                        );
                      })}
                    </div>
                  );
                })}
                {lang === 'english' && mode === 'follow' && state.progress !== null && !!state.cursor && (
                  // How far through the current ayah the recitation is; not a word-for-word claim.
                  <div className="en-progress" aria-hidden><span style={{ transform: `scaleX(${state.progress})` }} /></div>
                )}
                {plan.englishPages.length > 1 && (
                  <div className="cont">
                    Translation {englishPage + 1}/{plan.englishPages.length}
                    {englishPage < plan.englishPages.length - 1 ? ' · continues' : ''}
                  </div>
                )}
              </div>
            )}
            {state.style.showReference && (
              <footer className="reference">
                <span className="ref-ar" lang="ar" dir="rtl">
                  <span className="ref-surah">{v.surahNameArabic}</span>
                  {/* This Hafs font draws the end-of-ayah ornament around Arabic-Indic digits itself;
                      prefixing U+06DD would render a second, empty ornament. */}
                  <span className="ref-mark">{arabicNumber(v.ayah)}</span>
                </span>
                <span className="ref-en">
                  <span className="ref-name">{v.surahName}</span>
                  <span className="ref-key">{v.key}</span>
                </span>
                {lang !== 'arabic' && <span className="ref-credit">{v.translationName}</span>}
              </footer>
            )}
            {plan.next && state.next && (
              <aside
                className="next-ayah"
                aria-label={`Next: ${state.next.key}`}
                // The reciter has reached the last word: what comes next brightens, without moving.
                data-anticipate={anticipating || undefined}
              >
                {state.next.surahName && <div className="next-label">Next surah · {state.next.surahName}</div>}
                <div className={`next-line${plan.next.lang === 'en' ? ' next-en' : ''}${plan.next.cut ? ' next-cut' : ''}`} lang={plan.next.lang} dir={plan.next.lang === 'en' ? 'ltr' : 'rtl'} style={{ fontSize: plan.next.px }}>
                  {plan.next.words.join(' ')}
                </div>
              </aside>
            )}
          </article>
        )}
      </div>
    </div>
  );
}

/** Scales the fixed stage to fit its container (preview) or the window (overlay). */
export function StageFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(Math.min(el.clientWidth / STAGE_W, el.clientHeight / STAGE_H) || 1);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={`stage-frame ${className ?? ''}`}>
      <div className="stage-scaler" style={{ transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
