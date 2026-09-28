// Arabic normalization for recognition/search only. Display text is never passed through here.
//
// Two passes (documented so the index and live transcript always agree):
//   conservative: NFC; drop harakat, sukun, shadda, dagger alif (U+0670), Quranic annotation
//     marks (U+0610-061A, U+06D6-06ED), tatweel; map alif forms (أ إ آ ٱ) to bare alif.
//     Keeps ta marbuta, alif maqsura, hamza carriers and every root letter.
//   relaxed (retrieval/alignment key): conservative + ى→ي, ة→ه, ؤ→و, ئ→ي, standalone ء removed.
//     These collapse spelling choices ASR engines make inconsistently. They are used to *find*
//     candidates and to score similarity, never to rewrite what is displayed.

export const NORMALIZATION_VERSION = 'ar-n1';

const MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const ALIF_FORMS = /[آأإٱٲٳ]/g;
const ARABIC_LETTER = /[ء-يٱ-ۓ]/;
const LATIN_OR_DIGIT = /[A-Za-z0-9٠-٩]/;
const PUNCT = /[،؛؟٪-٭۔.,!?;:"'()[\]{}«»\-–—…]/g;

export function conservative(word: string): string {
  return word.normalize('NFC').replace(MARKS, '').replace(ALIF_FORMS, 'ا').replace(PUNCT, '');
}

export function relaxed(word: string): string {
  return conservative(word)
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ء/g, '');
}

export type NormToken = {
  /** Relaxed key used for retrieval/alignment. Empty tokens are dropped before this point. */
  key: string;
  /** Conservative form, for exact-match credit. */
  cons: string;
  /** Token is not Arabic recitation text (English commentary, numbers). */
  foreign: boolean;
};

export function tokenize(text: string): NormToken[] {
  const out: NormToken[] = [];
  for (const raw of text.normalize('NFC').split(/\s+/)) {
    if (!raw) continue;
    if (!ARABIC_LETTER.test(raw)) {
      const cleaned = raw.replace(PUNCT, '').toLowerCase();
      if (cleaned && LATIN_OR_DIGIT.test(cleaned)) out.push({ key: cleaned, cons: cleaned, foreign: true });
      continue;
    }
    const cons = conservative(raw);
    const key = relaxed(raw);
    if (key) out.push({ key, cons, foreign: false });
  }
  return out;
}

/** Levenshtein similarity in [0,1] between two short strings. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[lb] / Math.max(la, lb);
}

// Disjoint-letter (muqatta'at) openings are recited by letter name ("alif lam mim"),
// so ASR may emit the names rather than the written letters. The spoken-name spelling
// is a fixed property of each letter; it is added as an alternative search form only.
const LETTER_NAMES: Record<string, string[]> = {
  'ا': ['الف'],
  'ل': ['لام'],
  'م': ['ميم'],
  'ر': ['را'],
  'ص': ['صاد'],
  'ك': ['كاف'],
  'ه': ['ها'],
  'ي': ['يا'],
  'ع': ['عين'],
  'ط': ['طا'],
  'س': ['سين'],
  'ح': ['حا'],
  'ق': ['قاف'],
  'ن': ['نون'],
};

export const MUQATTAAT_LETTERS = new Set(Object.keys(LETTER_NAMES));

/** Spoken letter-name expansion for a disjoint-letter word, or null if any letter is not one of the 14. */
export function spokenLetterNames(word: string): string[] | null {
  const letters = relaxed(word);
  if (!letters) return null;
  const out: string[] = [];
  for (const ch of letters) {
    const names = LETTER_NAMES[ch];
    if (!names) return null;
    out.push(names[0]);
  }
  return out;
}
