import type { Access } from './net';

/** Mode discovery pending or failed: avoid claiming a hosted reader connects directly. */
export function audioRoute(mode: Access['mode'] | null): string {
  if (mode === 'hosted') return 'Your audio passes through Nurra’s server to Soniox for recognition.';
  if (mode === 'local') return 'Your audio goes directly from this browser to Soniox for recognition.';
  return 'Audio is sent to Soniox for recognition.';
}

export function transcriptUse(mode: Access['mode'] | null): string {
  const use = 'Recognised words are held temporarily to follow recitation and may go to OpenRouter or TypeSafe for matching.';
  if (mode === 'hosted') return `${use} Nurra’s public service does not save audio or transcripts to disk.`;
  if (mode === 'local') return `${use} Self-hosted diagnostic capture can save recognised words locally.`;
  return use;
}

// Voice detection and browser support affect silence skipping; Stop is the explicit control.
export const SILENCE_CONTROL = 'Transmission can pause after a long silence. Stop listening closes the microphone and recognition stream.';
export const REQUEST_PRIVACY = 'Requests may go to OpenRouter or TypeSafe.';
