/** Reciprocal rank fusion over ranked verse lists (k = 60). Order-only; scores are not compared across lists. */
export function reciprocalRankFusion(lists: ReadonlyArray<ReadonlyArray<{ verseIndex: number }>>, k = 60): Array<{ verseIndex: number; score: number }> {
  const acc = new Map<number, number>();
  for (const list of lists) {
    list.forEach((item, rank) => acc.set(item.verseIndex, (acc.get(item.verseIndex) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...acc.entries()].map(([verseIndex, score]) => ({ verseIndex, score })).sort((a, b) => b.score - a.score || a.verseIndex - b.verseIndex);
}
