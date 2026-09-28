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
};

type Geometry = { width: number; height: number; refH: number; gap: number };

const FULL: Geometry = { width: 1560, height: 812, refH: 64, gap: 34 };
const LOWER: Geometry = { width: 1600, height: 318, refH: 48, gap: 16 };

function planFor(state: DisplayState): Plan | null {
  const v = state.verse;
  if (!v) return null;
  const scale = state.style.arabicScale;
  const arWords = toQpcHafsEncoding(v.arabic).split(/\s+/).filter(Boolean);
  const enWords = state.style.showTranslation ? v.english.split(/\s+/).filter(Boolean) : [];

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
  const single = (fit: { a: number; e: number; al: Lines; el: Lines }, layout: Plan['layout'], promoted: boolean): Plan => ({
    layout,
    promoted,
    arabicPx: fit.a,
    englishPx: fit.e,
    arabicPages: [fit.al],
    englishPages: [fit.el],
    arabicPageWordStarts: [0],
  });

  if (state.style.layout === 'lowerthird') {
    const fit = tryFit(LOWER, Math.round(62 * scale), Math.round(46 * scale), 30, 26);
    if (fit) return single(fit, 'lowerthird', false);
  }
  const fit = tryFit(FULL, Math.round(108 * scale), Math.round(54 * scale), 44, 31);
  const promoted = state.style.layout === 'lowerthird';
  if (fit) return single(fit, 'fullframe', promoted);

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
  };
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
  const planKey = v ? `${v.key}|${state.style.layout}|${state.style.arabicScale}|${state.style.showTranslation}` : '';
  // Layout is computed synchronously from measured line boxes before paint.
  const plan = useMemo(() => (fontsReady && v ? planFor(state) : null), [planKey, fontsReady]); // eslint-disable-line react-hooks/exhaustive-deps

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
    else if (state.progress !== null && nA > 1) {
      const total = plan.arabicPageWordStarts[nA - 1] + plan.arabicPages[nA - 1].reduce((n, l) => n + l.length, 0);
      const word = Math.floor(state.progress * total);
      for (let i = 0; i < nA; i++) if (plan.arabicPageWordStarts[i] <= word) arabicPage = i;
    }
    englishPage = state.englishPage % plan.englishPages.length;
  }

  const layout = plan?.layout ?? state.style.layout;
  return (
    <div className="stage" data-bg={state.style.background} data-layout={layout} data-preview={preview || undefined}>
      <div className={`panel ${visible ? 'panel-on' : 'panel-off'}`} aria-hidden={!visible}>
        {visible && plan && v && (
          <article className="verse" key={v.key} aria-label={`${v.surahName} ${v.key}`}>
            <div className="arabic" lang="ar" dir="rtl" style={{ fontSize: plan.arabicPx }}>
              {plan.arabicPages[arabicPage].map((line, i) => (
                <div className="line" key={i}>
                  {line.join(' ')}
                </div>
              ))}
              {plan.arabicPages.length > 1 && (
                <div className="cont cont-ar" aria-label={`Arabic part ${arabicPage + 1} of ${plan.arabicPages.length}`}>
                  {arabicPage < plan.arabicPages.length - 1 ? 'continues' : 'end of ayah'} · {arabicPage + 1}/{plan.arabicPages.length}
                </div>
              )}
            </div>
            {state.style.showTranslation && plan.englishPages[englishPage].length > 0 && (
              <div className="english" lang="en" style={{ fontSize: plan.englishPx }}>
                {plan.englishPages[englishPage].map((line, i) => (
                  <div className="line" key={i}>
                    {line.join(' ')}
                  </div>
                ))}
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
                <span className="ref-credit">{v.translationName}</span>
              </footer>
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
