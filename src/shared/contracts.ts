// The one contract owner for control ⇄ server ⇄ overlay messages. Every producer and consumer
// imports from here; there is no second display truth (Moard cross-runtime-integrity rule).

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const LayoutSchema = z.enum(['fullframe', 'lowerthird']);
export const BackgroundSchema = z.enum(['transparent', 'scrim', 'solid']);

export const DisplayStyleSchema = z.object({
  readingMode: z.enum(['follow', 'ayah', 'word']).default('follow'),
  layout: LayoutSchema,
  background: BackgroundSchema,
  showTranslation: z.boolean(),
  showReference: z.boolean(),
  /** The following ayah, dimmed under the current one, so readers see what comes next. */
  showNext: z.boolean().default(true),
  arabicScale: z.number().min(0.8).max(1.25),
  /** Seconds per translation page when a translation overflows; 0 = broadcaster pages manually. */
  translationPageSeconds: z.number().int().min(0).max(60),
});
export type DisplayStyle = z.infer<typeof DisplayStyleSchema>;

export const DEFAULT_STYLE: DisplayStyle = {
  readingMode: 'follow',
  layout: 'fullframe',
  background: 'scrim',
  showTranslation: true,
  showReference: true,
  showNext: true,
  arabicScale: 1,
  translationPageSeconds: 0,
};

export const DisplayVerseSchema = z.object({
  key: z.string().regex(/^\d{1,3}:\d{1,3}$/),
  surah: z.number().int().min(1).max(114),
  ayah: z.number().int().min(1).max(286),
  arabic: z.string().min(1),
  english: z.string().min(1),
  surahName: z.string(),
  surahNameArabic: z.string(),
  translationName: z.string(),
});
export type DisplayVerse = z.infer<typeof DisplayVerseSchema>;

export const DisplayStateSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  revision: z.number().int().nonnegative(),
  sessionEpoch: z.string(),
  visible: z.boolean(),
  verse: DisplayVerseSchema.nullable(),
  style: DisplayStyleSchema,
  englishPage: z.number().int().nonnegative(),
  /** null = follow recitation progress (when available), number = broadcaster-chosen page. */
  arabicPage: z.number().int().nonnegative().nullable(),
  /** Recited position within the verse as a fraction of its words, only for paging long verses. */
  progress: z.number().min(0).max(1).nullable(),
  /** Display-word coordinates, validated against the selected display script. */
  cursor: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), provisional: z.boolean() }).nullable().optional(),
  /** The ayah after the current one (a preview, never a claim about where the reciter is). */
  next: z
    .object({
      key: z.string().regex(/^\d{1,3}:\d{1,3}$/),
      surah: z.number().int().min(1).max(114),
      ayah: z.number().int().min(1).max(286),
      arabic: z.string().min(1),
      /** Set only when the next ayah opens a new surah. */
      surahName: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export type DisplayState = z.infer<typeof DisplayStateSchema>;

// ---------- overlay channel ----------

export const OverlayClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), view: z.string().min(8).max(128), role: z.enum(['overlay', 'preview']) }),
  z.object({ type: z.literal('painted'), revision: z.number().int().nonnegative() }),
]);
export type OverlayClientMessage = z.infer<typeof OverlayClientMessageSchema>;

export type OverlayServerMessage =
  | { type: 'display'; state: DisplayState }
  | { type: 'denied'; reason: 'invalid_view' | 'revoked' };

// ---------- control channel ----------

export const WireTokenSchema = z.object({
  text: z.string().max(200),
  isFinal: z.boolean(),
  startMs: z.number().finite().optional(),
  endMs: z.number().finite().optional(),
  confidence: z.number().finite().optional(),
});

export const TrackerModeSchema = z.enum(['deterministic', 'hybrid', 'jev_required']);

export const StylePatchSchema = DisplayStyleSchema.partial();

export const ControlClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('transcript'),
    captureEpoch: z.number().int().positive(),
    seq: z.number().int().nonnegative(),
    tokens: z.array(WireTokenSchema).max(600),
    /** Control browser monotonic ms at receipt from the provider (trace only; clocks are not mixed). */
    receivedAt: z.number().finite(),
  }),
  z.object({
    type: z.literal('capture'),
    captureEpoch: z.number().int().positive(),
    event: z.enum(['starting', 'recording', 'reconnecting', 'stopped', 'error', 'muted', 'unmuted']),
    detail: z.string().max(240).optional(),
  }),
  z.object({ type: z.literal('nav'), action: z.enum(['next', 'prev']) }),
  z.object({ type: z.literal('goto'), key: z.string().max(8) }),
  z.object({ type: z.literal('hold'), on: z.boolean() }),
  z.object({ type: z.literal('blank'), on: z.boolean() }),
  z.object({ type: z.literal('pin'), on: z.boolean() }),
  z.object({ type: z.literal('style'), patch: StylePatchSchema }),
  z.object({ type: z.literal('page'), region: z.enum(['english', 'arabic']), page: z.number().int().min(0).max(200) }),
  /** Page counts measured by the control's same-size preview for the displayed revision. */
  z.object({
    type: z.literal('layout'),
    revision: z.number().int().nonnegative(),
    key: z.string().max(8),
    englishPages: z.number().int().min(1).max(200),
    arabicPages: z.number().int().min(1).max(200),
    promotedToFullFrame: z.boolean(),
  }),
  z.object({ type: z.literal('arabic_auto') }),
  z.object({ type: z.literal('mode'), mode: TrackerModeSchema }),
  z.object({ type: z.literal('start_hint'), key: z.string().max(8).nullable() }),
  z.object({ type: z.literal('uncertain_policy'), keep: z.boolean() }),
  z.object({ type: z.literal('command'), requestId: z.string().min(1).max(64), text: z.string().max(300), source: z.enum(['typed', 'voice']) }),
  z.object({ type: z.literal('show_result'), requestId: z.string().min(1).max(64), key: z.string().max(8) }),
  z.object({ type: z.literal('rotate_view') }),
  /** Push-to-talk held: recitation publication pauses and in-flight location decisions are dropped. */
  z.object({ type: z.literal('command_capture'), active: z.boolean() }),
]);
export type ControlClientMessage = z.infer<typeof ControlClientMessageSchema>;

export type SearchCard = {
  key: string;
  surahName: string;
  arabic: string;
  english: string;
  prevKey: string | null;
  nextKey: string | null;
  /** Which retrieval channels found this passage (translation wording, meaning, QUL topic, reference). */
  foundBy: string[];
};

export type CommandResult =
  | { kind: 'navigate'; key: string; note: string | null }
  | {
      kind: 'candidates';
      route: 'search' | 'chapter';
      query: string;
      cards: SearchCard[];
      /** Key JEV selected among the retrieved cards, if any. */
      confirmedKey: string | null;
      status: string;
      /** Preliminary cards shown while JEV is still choosing; a final result follows. */
      refining: boolean;
    }
  | { kind: 'no_match'; message: string }
  | { kind: 'invalid_reference'; message: string };

export type CapturePhase = 'off' | 'starting' | 'recording' | 'reconnecting' | 'stopped' | 'error' | 'disconnected';
export type TrackerPhase = 'idle' | 'listening_unlocated' | 'tracking' | 'uncertain' | 'held' | 'stopped' | 'disconnected' | 'error';

export type CandidateView = { key: string; score: number; relation: string; matched: number; trailing: number };

export type DecisionView = {
  at: number;
  reason: string;
  outcome: string;
  detail: string;
  latencyMs: number;
  shortlist: string[];
  truncated: boolean;
  changedOverlay: boolean;
};

export type ControlSnapshot = {
  v: typeof PROTOCOL_VERSION;
  sessionEpoch: string;
  corpus: { id: string; verses: number; chapters: number; translation: string; attribution: string };
  display: DisplayState;
  layout: { key: string; englishPages: number; arabicPages: number; promotedToFullFrame: boolean } | null;
  /** Where the tracker currently believes the reciter is (may differ from display while held). */
  trackerVerse: string | null;
  phase: TrackerPhase;
  mode: z.infer<typeof TrackerModeSchema>;
  held: boolean;
  blanked: boolean;
  pinned: boolean;
  keepOnUncertain: boolean;
  startHint: string | null;
  capture: { phase: CapturePhase; captureEpoch: number; detail: string | null; since: number };
  heard: { final: string; provisional: string };
  candidates: CandidateView[];
  decisions: DecisionView[];
  setup: {
    soniox: boolean;
    jev: { provider: 'typesafe' | 'openrouter' | null; configured: boolean; detail: string };
    semantic: string;
    /** Resource capability status for the broadcaster/developer (never shown on the overlay). */
    resources: Array<{ id: string; title: string; state: string; detail: string }>;
  };
  overlay: { url: string; clients: number; lastPaintRttMs: number | null };
  metrics: {
    trackerP50Ms: number | null;
    trackerP95Ms: number | null;
    updates: number;
    decisionCalls: number;
    decisionP50Ms: number | null;
    paintRttP50Ms: number | null;
    paintRttP95Ms: number | null;
  };
  notice: string | null;
  /**
   * Evidence behind the latest live display change, for the control-side speed meter: the provider
   * audio time (ms from stream start) of the newest heard word when the screen moved.
   */
  speed: { revision: number; captureEpoch: number; verseKey: string; verseChanged: boolean; heardEndMs: number } | null;
};

export type ControlServerMessage =
  | { type: 'snapshot'; snapshot: ControlSnapshot }
  | { type: 'command_pending'; requestId: string }
  | { type: 'command_result'; requestId: string; result: CommandResult };
