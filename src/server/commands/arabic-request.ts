// "سورة الرحمن": a surah requested by name in Arabic. Said in Arabic, or English that the
// Arabic-tuned recogniser wrote in Arabic script ("قولت سورة الرحمن" for "go to Surah Rahman").
// Safe inside recitation: "سورة" occurs in the Quran (2:23, 9:64, 9:86, 9:124, 9:127, 10:38,
// 24:1, 47:20) but is never followed by a surah's name.
import { relaxed } from '../tracker/normalize';

export type SurahRequest = { chapter: number; end: number };

const shared = new WeakMap<object, ArabicSurahRequests>();

export class ArabicSurahRequests {
  private readonly names: Array<{ chapter: number; parts: string[] }> = [];

  /** One per corpus: it never changes after it is built, and it was ~90% of a visitor's session. */
  static for(chapters: ReadonlyArray<{ number: number; nameArabic: string }>): ArabicSurahRequests {
    let r = shared.get(chapters);
    if (!r) shared.set(chapters, (r = new ArabicSurahRequests(chapters)));
    return r;
  }

  constructor(chapters: ReadonlyArray<{ number: number; nameArabic: string }>) {
    for (const c of chapters) {
      const parts = c.nameArabic.split(/\s+/).map(relaxed).filter(Boolean);
      this.names.push({ chapter: c.number, parts });
      // "سورة رحمن" as well as "سورة الرحمن".
      if (parts.length === 1 && parts[0].startsWith('ال') && parts[0].length > 3) this.names.push({ chapter: c.number, parts: [parts[0].slice(2)] });
    }
    // Longest names first, so "آل عمران" is not read as a shorter name.
    this.names.sort((a, b) => b.parts.length - a.parts.length || b.parts.join('').length - a.parts.join('').length);
  }

  /**
   * The first request in `words` at or after `from`: the chapter and the index after its name.
   * With `lastOpen`, the last word is still forming: a name ending there counts only if it cannot
   * still grow into another surah's name ("سورة ق…" may become قريش; "سورة الرحمن" cannot), so a
   * request is not held back until the recogniser finalizes it (seconds, at the end of speech).
   */
  find(words: readonly string[], from = 0, lastOpen = false): SurahRequest | null {
    const start = Math.max(0, from);
    const keys = words.slice(start).map(relaxed);
    for (let i = 0; i < keys.length - 1; i++) {
      if (keys[i] !== 'سوره') continue;
      for (const n of this.names) {
        if (!n.parts.every((p, k) => keys[i + 1 + k] === p)) continue;
        const end = i + 1 + n.parts.length;
        if (lastOpen && end === keys.length && !this.complete(n.parts)) continue;
        return { chapter: n.chapter, end: start + end };
      }
    }
    return null;
  }

  private complete(parts: string[]): boolean {
    const said = parts.join(' ');
    return !this.names.some((o) => o.parts.join(' ') !== said && o.parts.join(' ').startsWith(said));
  }
}
