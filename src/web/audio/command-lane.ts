// Push-to-talk separation on the shared Soniox stream. Command words are bounded by provider audio
// timestamps within the press/release interval, not by the cumulative transcript, so recitation
// and command evidence stay distinct (Moard: "each finalize returns only that breath's words").
// Tokens straddling the press boundary make separation unreliable: the text is then shown for
// correction instead of executed.

import { isMarker, type WireToken } from '../../shared/transcript';

export const RELEASE_TAIL_MS = 300;

export type CommandCapture = { text: string; clean: boolean; reason: string | null };

type Window = { start: number; end: number | null; finals: WireToken[]; provisional: WireToken[]; straddled: boolean; finalized: boolean };

export class TokenRouter {
  private w: Window | null = null;

  get active() {
    return !!this.w;
  }

  get awaitingFinal() {
    return !!this.w && this.w.end !== null && !this.w.finalized;
  }

  begin(audioMs: number) {
    this.w = { start: audioMs, end: null, finals: [], provisional: [], straddled: false, finalized: false };
  }

  release(audioMs: number) {
    if (this.w && this.w.end === null) this.w.end = audioMs;
  }

  cancel() {
    this.w = null;
  }

  /** Live command text (finals + current provisional) for on-screen feedback. */
  hearing(): string {
    if (!this.w) return '';
    return [...this.w.finals, ...this.w.provisional].map((t) => t.text).join('').trim();
  }

  /** Split one provider result into recitation tokens and command tokens. */
  route(tokens: readonly WireToken[]): { recitation: WireToken[]; finalized: boolean } {
    const w = this.w;
    if (!w) return { recitation: [...tokens], finalized: false };
    const recitation: WireToken[] = [];
    const provisional: WireToken[] = [];
    let finalized = false;
    for (const t of tokens) {
      if (isMarker(t.text)) {
        if (t.isFinal && t.text.trim() === '<fin>' && w.end !== null) {
          finalized = true;
          w.finalized = true;
          continue;
        }
        recitation.push(t);
        continue;
      }
      const s = t.startMs;
      const e = t.endMs ?? s;
      let toCommand: boolean;
      if (s === undefined) toCommand = true;
      else if (s >= w.start) toCommand = w.end === null || s < w.end + RELEASE_TAIL_MS;
      else if (e !== undefined && e > w.start) {
        toCommand = true;
        w.straddled = true;
      } else toCommand = false;
      if (!toCommand) recitation.push(t);
      else if (t.isFinal) w.finals.push(t);
      else provisional.push(t);
    }
    w.provisional = provisional;
    return { recitation, finalized };
  }

  /** Close the window after the provider finalized (or the wait timed out). */
  finish(timedOut = false): CommandCapture {
    const w = this.w;
    this.w = null;
    if (!w) return { text: '', clean: false, reason: 'no command captured' };
    const text = [...w.finals, ...(timedOut ? w.provisional : [])].map((t) => t.text).join('').replace(/\s+/g, ' ').trim();
    if (!text) return { text, clean: false, reason: 'Nothing was heard while the button was held.' };
    if (w.straddled) return { text, clean: false, reason: 'Speech overlapped the button press; check the words before running.' };
    if (/[؀-ۿ]/.test(text)) return { text, clean: false, reason: 'Arabic was heard during the command; check the words before running.' };
    if (timedOut) return { text, clean: false, reason: 'The recognizer did not confirm the final words in time; check them before running.' };
    return { text, clean: true, reason: null };
  }
}
