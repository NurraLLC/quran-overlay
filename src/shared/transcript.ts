// Soniox token stream → words. Shared by the browser (command lane) and the server (recitation lane).
//
// Contract (Soniox real-time): tokens are subwords carrying their own leading space; final tokens
// arrive exactly once and in order; each result's non-final tokens replace the previous provisional
// suffix entirely. `<end>` (endpoint) and `<fin>` (manual finalize) are markers, never words.
// Ported from Moard harbor/intelligence/soniox_stream.py `_take` (see docs/REUSE_NOTES.md).

export type WireToken = {
  text: string;
  isFinal: boolean;
  startMs?: number;
  endMs?: number;
  confidence?: number;
};

export type Word = {
  text: string;
  startMs: number | null;
  endMs: number | null;
  /** Index in the closed-final word list of this capture epoch; -1 for provisional words. */
  index: number;
  /** Not closed yet: the provider may still extend or rewrite it (e.g. "فلع" → "فلعلك"). */
  open?: boolean;
};

export type ApplyResult = {
  closedAdded: number;
  /** Closed words were added or the open final word changed: evidence() differs. */
  evidenceChanged: boolean;
  provisionalChanged: boolean;
  endpoint: boolean;
  finalized: boolean;
};

const MARKER = /^<[^\s<>]+>$/;

export function isMarker(text: string): boolean {
  return MARKER.test(text.trim());
}

type Pending = { text: string; startMs: number | null; endMs: number | null };

export class TranscriptBuffer {
  private closed: Word[] = [];
  private pending: Pending | null = null;
  private provisional: WireToken[] = [];
  private provisionalKey = '';

  /** Words finalized by the provider and closed by a following boundary. Append-only. */
  get finals(): readonly Word[] {
    return this.closed;
  }

  /**
   * Finalized evidence for tracking: closed words plus the open final word. The open word is final
   * text whose end has not been proven yet (the next token has not arrived); waiting for that
   * boundary would delay every ayah's last word by the whole pause after it.
   */
  evidence(): Word[] {
    if (!this.pending?.text) return this.closed;
    return [...this.closed, { ...this.pending, index: this.closed.length }];
  }

  apply(tokens: readonly WireToken[]): ApplyResult {
    const before = this.closed.length;
    const pendingBefore = this.pending?.text ?? '';
    let endpoint = false;
    let finalized = false;
    const nextProvisional: WireToken[] = [];
    for (const t of tokens) {
      if (!t.isFinal) {
        if (!isMarker(t.text)) nextProvisional.push(t);
        continue;
      }
      const marker = t.text.trim();
      if (marker === '<end>') {
        endpoint = true;
        this.closePending();
        continue;
      }
      if (marker === '<fin>') {
        finalized = true;
        this.closePending();
        continue;
      }
      if (isMarker(t.text)) continue;
      this.appendFinal(t);
    }
    const key = nextProvisional.map((t) => t.text).join('');
    const provisionalChanged = key !== this.provisionalKey;
    this.provisional = nextProvisional;
    this.provisionalKey = key;
    // A provisional token that starts a new word proves the pending final word is complete.
    if (this.pending && nextProvisional.length && /^\s/.test(nextProvisional[0].text)) this.closePending();
    const closedAdded = this.closed.length - before;
    const evidenceChanged = closedAdded > 0 || (this.pending?.text ?? '') !== pendingBefore;
    return { closedAdded, evidenceChanged, provisionalChanged, endpoint, finalized };
  }

  /** Close the trailing final word (e.g. capture stopped). */
  flush(): number {
    const before = this.closed.length;
    this.closePending();
    return this.closed.length - before;
  }

  /** Words not yet closed-final: the open final word followed by the provisional suffix. */
  provisionalWords(): Word[] {
    const out: Word[] = [];
    let cur: Pending | null = this.pending ? { ...this.pending } : null;
    const push = () => {
      if (cur && cur.text) out.push({ text: cur.text, startMs: cur.startMs, endMs: cur.endMs, index: -1 });
      cur = null;
    };
    for (const t of this.provisional) {
      const parts = t.text.split(/(\s+)/);
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          push();
          continue;
        }
        if (!cur) cur = { text: part, startMs: t.startMs ?? null, endMs: t.endMs ?? null };
        else {
          cur.text += part;
          cur.endMs = t.endMs ?? cur.endMs;
        }
      }
    }
    push();
    return out;
  }

  heardText(maxWords = 24): { final: string; provisional: string } {
    const f = this.closed.slice(-maxWords).map((w) => w.text).join(' ');
    return { final: f, provisional: this.provisionalWords().map((w) => w.text).join(' ') };
  }

  /** Complete current hypothesis, with the pending final subword included exactly once. */
  liveWords(): Word[] { return [...this.closed, ...this.provisionalWords().map((w) => ({ ...w, open: true }))]; }

  get hasProvisional(): boolean { return this.provisional.length > 0; }

  private appendFinal(t: WireToken) {
    const parts = t.text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        this.closePending();
        continue;
      }
      if (!this.pending) this.pending = { text: part, startMs: t.startMs ?? null, endMs: t.endMs ?? null };
      else {
        this.pending.text += part;
        this.pending.endMs = t.endMs ?? this.pending.endMs;
      }
    }
  }

  private closePending() {
    if (this.pending && this.pending.text) {
      this.closed.push({ ...this.pending, index: this.closed.length });
    }
    this.pending = null;
  }
}
