// Display encoding for the KFGQPC Uthmanic Hafs font (QUL font 245).
//
// Our display source (Quran.com Uthmani) and QPC-Hafs (the text this font is built for) encode
// these Mushaf marks with different codepoints:
//   mark                       Quran.com Uthmani   QPC-Hafs / this font
//   silent letter (round zero) U+06DF              U+0652
//   sukun (jazm)               U+0652              U+06E1
//   rounded high stop (12:11)  U+06EB              U+06EC
// Rendering the source directly draws every U+06DF as an unattached dotted circle (verified in the
// browser) and every sukun as a round zero. This is a codepoint mapping for the same marks, not a
// text change; scripts/check-display-encoding.ts measures it against QUL's QPC-Hafs text.
// Known remaining defect: U+06E3 (small low seen, only in 52:37) still renders unattached; QPC
// evidence for it is not in the local sample, so it is not guessed. Importing QUL resource 86
// (QPC-Hafs text) would replace this mapping entirely.
// Search/recognition never uses this (it reads the Imlaei text).

const MAP: ReadonlyMap<string, string> = new Map([
  [String.fromCodePoint(0x0652), String.fromCodePoint(0x06e1)],
  [String.fromCodePoint(0x06df), String.fromCodePoint(0x0652)],
  [String.fromCodePoint(0x06eb), String.fromCodePoint(0x06ec)],
]);

export function toQpcHafsEncoding(uthmani: string): string {
  let out = '';
  for (const ch of uthmani) out += MAP.get(ch) ?? ch;
  return out;
}

/** Codepoints verified to render unattached with this font even after re-encoding. */
export const KNOWN_UNRENDERABLE: ReadonlySet<number> = new Set([0x06e3]);
