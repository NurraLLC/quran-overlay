import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';

/** Unicode codepoints the font's cmap maps to a glyph (glyph 0 / .notdef excluded). */
export function fontCodepoints(file: string): { codepoints: Set<number>; family: string } {
  const buf = readFileSync(file);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const map = (font.tables.cmap as unknown as { glyphIndexMap: Record<string, number> }).glyphIndexMap;
  const codepoints = new Set<number>();
  for (const [cp, gid] of Object.entries(map)) if (gid > 0) codepoints.add(Number(cp));
  const family = font.names.fontFamily?.en ?? 'UthmanicHafs';
  return { codepoints, family };
}
