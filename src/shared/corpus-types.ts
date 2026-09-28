// Processed-corpus records shared by the importer, server engine and web display.
// Display text is immutable source text; search normalization lives in src/server/tracker/normalize.ts.

export type VerseKey = `${number}:${number}`;

export type Chapter = {
  number: number;
  nameArabic: string;
  nameSimple: string;
  nameComplex: string;
  verseCount: number;
  bismillahPre: boolean;
};

export type Verse = {
  /** Canonical order index, 0..6235. */
  index: number;
  key: VerseKey;
  surah: number;
  ayah: number;
  /** Uthmani display text, exactly as sourced (outer whitespace trimmed). */
  arabicDisplay: string;
  /** Imlaei text used only for recognition/search normalization. */
  searchText: string;
  /** English with footnote reference markers removed; words otherwise untouched. */
  english: string;
  /** Source footnote ids referenced by this verse. Footnote bodies are not in the local corpus. */
  footnoteIds: number[];
};

export type SourceFile = {
  role: 'arabicDisplay' | 'arabicSearch' | 'english' | 'chapters' | 'font';
  path: string;
  sourceUrl: string;
  sha256: string;
  bytes: number;
  downloadedAt: string;
  sourceResourceId?: string;
  licenseStatus: string;
  attribution: string;
  displayName?: string;
};

export type CorpusManifest = {
  id: string;
  narration: 'hafs';
  schemaVersion: 1;
  normalizationVersion: string;
  verseCount: number;
  builtAt: string;
  sourceFiles: SourceFile[];
  translation: { name: string; resource: string; attribution: string };
  font: { family: string; file: string; sha256: string };
};

export type ProcessedCorpus = {
  manifest: CorpusManifest;
  chapters: Chapter[];
  verses: Verse[];
};

export const HAFS_VERSE_COUNTS: readonly number[] = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
  112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
  54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
  14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
  29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
  11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
];

export const TOTAL_AYAHS = 6236;

/** Ayahs whose first word is a disjoint-letter (muqatta'at) opening in Hafs. Checked by corpus:validate. */
export const MUQATTAAT_KEYS: ReadonlySet<string> = new Set([
  '2:1', '3:1', '7:1', '10:1', '11:1', '12:1', '13:1', '14:1', '15:1', '19:1', '20:1', '26:1', '27:1', '28:1',
  '29:1', '30:1', '31:1', '32:1', '36:1', '38:1', '40:1', '41:1', '42:1', '42:2', '43:1', '44:1', '45:1', '46:1',
  '50:1', '68:1',
]);

export function parseVerseKey(key: string): { surah: number; ayah: number } | null {
  const m = /^(\d{1,3}):(\d{1,3})$/.exec(key.trim());
  if (!m) return null;
  const surah = Number(m[1]);
  const ayah = Number(m[2]);
  if (surah < 1 || surah > 114) return null;
  if (ayah < 1 || ayah > HAFS_VERSE_COUNTS[surah - 1]) return null;
  return { surah, ayah };
}
