// Resource layer types. One owner (ResourceCatalog) loads verified compiled artifacts and serves the
// tracker, search, display and the control-side status report. Canonical identity is surah:ayah
// for all 6,236 verses; word identities also carry their script/source; topic, phrase and resource
// ids stay in their own namespaces.

export type ResourceFormat = 'json' | 'sqlite' | 'csv' | 'font' | 'audio' | 'derived';

/** Selected, pinned resource version (recorded in corpus/resources.lock.json). */
export type ResourceVersion = {
  id: string; // e.g. qul:similar-ayah:74
  category: string;
  sourceUrl: string;
  downloadedAt: string;
  sha256: string;
  format: ResourceFormat;
  narration: string | null;
  script: string | null;
  language: string | null;
  attribution: string;
  rightsEvidence: string | null;
  coverage: { rows: number; verseKeys: number; rejectedRows: number };
};

/** Separate facts, never one ambiguous "ready" flag. */
export type ResourceStage = {
  catalogued: boolean;
  downloaded: boolean;
  validated: boolean;
  indexed: boolean;
  /** Named features that actually read this resource at runtime. */
  consumers: string[];
  /** Path of the evaluation showing a behavioural effect, if any. */
  evaluated: string | null;
};

export type ResourceStatus = {
  id: string;
  category: string;
  title: string;
  stage: ResourceStage;
  coverage: ResourceVersion['coverage'] | null;
  sha256: string | null;
  /** Why an expected input is missing or partial; never hides a gap behind an empty result. */
  note: string | null;
};

/** A relationship between two verses from one source, with the word ranges that justify it. */
export type VerseEdge = {
  from: number; // verse index
  to: number;
  source: string; // resource id
  /** 1-based word ranges in the source's own word coordinates (script noted on the resource). */
  fromRanges: Array<[number, number]>;
  toRanges: Array<[number, number]>;
  /** Source-defined strength (e.g. QUL similarity score); never an ASR/spoken probability. */
  strength: number;
};
