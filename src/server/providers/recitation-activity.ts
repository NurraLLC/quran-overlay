import { tokenize } from '../tracker/normalize';

// A generous activity signal, not tajweed grading or a claim of Quran correctness.
// Only provider-originated words may reach this check. Display still uses the real tracker.
export function recitationActivity(words: string[]): (text: string) => boolean {
  const triples = new Set<string>();
  for (let i = 2; i < words.length; i++) triples.add(words.slice(i - 2, i + 1).join(' '));
  return (text) => {
    const tokens = tokenize(text).slice(-6);
    for (let i = Math.max(2, tokens.length - 3); i < tokens.length; i++) {
      if (tokens.slice(i - 2, i + 1).some((t) => t.foreign)) continue;
      if (triples.has(tokens.slice(i - 2, i + 1).map((t) => t.key).join(' '))) return true;
    }
    return false;
  };
}
