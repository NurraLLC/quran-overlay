// Word-by-word English glosses (optional resource). Built by scripts/import-wbw.ts into
// data/processed/wbw-en.json: per ayah, one entry per display token (null for a pause mark).
// Absent file = no glosses; everything else works unchanged.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROCESSED_DIR } from './manifest';

export class WordGlosses {
  private constructor(
    private readonly verses: Record<string, Array<string | null>>,
    readonly attribution: string,
  ) {}

  static load(file = path.join(PROCESSED_DIR, 'wbw-en.json')): WordGlosses | null {
    if (!existsSync(file)) return null;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { attribution?: string; verses?: Record<string, Array<string | null>> };
      return j.verses ? new WordGlosses(j.verses, j.attribution ?? 'Word by word') : null;
    } catch {
      return null;
    }
  }

  get size() {
    return Object.keys(this.verses).length;
  }

  /** Glosses aligned to the ayah's display tokens, or null when this ayah has none. */
  get(key: string): Array<string | null> | null {
    return this.verses[key] ?? null;
  }
}
