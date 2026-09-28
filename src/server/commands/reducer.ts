// Resolve a parsed English command into a CommandResult. Exact references resolve locally and
// instantly; meaning search retrieves candidates from the full translation, then (optionally)
// JEV selects among those real passages. Results never publish by themselves.

import type { CommandResult, SearchCard } from '../../shared/contracts';
import type { Corpus } from '../corpus/load';
import { buildCommandChoice, buildSearchChoice, NO_ACTION, NO_MATCH } from '../providers/decisions';
import type { DecisionClient } from '../providers/jev';
import { Bm25Index } from '../search/lexical';
import { reciprocalRankFusion } from '../search/rank';
import { ChapterNames } from '../search/references';
import type { SemanticRetriever } from '../search/semantic';
import { parseIntent, type Intent } from './parse';

export const SEARCH_DEADLINE_MS = 2000;
const LEXICAL_K = 30;
const SEMANTIC_K = 30;
const TO_JEV = 24;
const CARDS = 5;

export type SearchTrace = {
  lexical: number[];
  semantic: number[];
  fused: number[];
  jev: { outcome: string; latencyMs: number | null; choice: string | null };
};

export class CommandResolver {
  readonly names: ChapterNames;
  readonly bm25: Bm25Index;
  lastTrace: SearchTrace | null = null;

  constructor(
    readonly corpus: Corpus,
    private readonly semantic: SemanticRetriever | null,
    public client: DecisionClient | null,
  ) {
    this.names = new ChapterNames(corpus.data.chapters);
    this.bm25 = new Bm25Index(corpus.verses.map((v) => ({ verseIndex: v.index, source: 'english:primary', text: v.english })));
  }

  parse(text: string, currentSurah: number | null): Intent {
    return parseIntent(text, this.names, currentSurah);
  }

  card(index: number): SearchCard {
    const v = this.corpus.at(index)!;
    return {
      key: v.key,
      surahName: this.corpus.chapter(v.surah)!.nameSimple,
      arabic: v.arabicDisplay,
      english: v.english,
      prevKey: index > 0 ? this.corpus.at(index - 1)!.key : null,
      nextKey: index < this.corpus.verses.length - 1 ? this.corpus.at(index + 1)!.key : null,
    };
  }

  async resolve(text: string, currentIndex: number | null, signal?: AbortSignal): Promise<CommandResult> {
    const current = currentIndex !== null ? this.corpus.at(currentIndex)! : null;
    const intent = this.parse(text, current?.surah ?? null);
    switch (intent.kind) {
      case 'empty':
        return { kind: 'no_match', message: 'Type or say a reference (2:255, Surah Maryam ayah 3) or what the verse is about.' };
      case 'next':
      case 'previous': {
        if (currentIndex === null) return { kind: 'invalid_reference', message: 'Nothing is on screen yet, so there is no next or previous ayah.' };
        const to = currentIndex + (intent.kind === 'next' ? 1 : -1);
        const v = this.corpus.at(to);
        if (!v) return { kind: 'invalid_reference', message: intent.kind === 'next' ? 'That is the last ayah of the Quran.' : 'That is the first ayah of the Quran.' };
        return { kind: 'navigate', key: v.key, note: null };
      }
      case 'invalid_reference':
        return intent;
      case 'reference': {
        const ch = this.corpus.chapter(intent.surah)!;
        const ayah = intent.ayah ?? 1;
        const note = intent.ayah === null ? `Surah ${ch.nameSimple} starts at ${intent.surah}:1.` : intent.route === 'named_passage' ? `Named passage → ${intent.surah}:${ayah}.` : null;
        return { kind: 'navigate', key: `${intent.surah}:${ayah}`, note };
      }
      case 'ambiguous_chapter':
        return this.ambiguousChapter(text, intent, current?.key ?? null, signal);
      case 'search':
        return this.search(intent.query, signal);
    }
  }

  private async ambiguousChapter(text: string, intent: Extract<Intent, { kind: 'ambiguous_chapter' }>, currentKey: string | null, signal?: AbortSignal): Promise<CommandResult> {
    const keys = intent.options.map((o) => `${o.number}:${Math.min(intent.ayah ?? 1, this.corpus.chapter(o.number)!.verseCount)}`);
    let confirmedKey: string | null = null;
    let status = 'Several surah names match; choose one.';
    if (this.client) {
      try {
        const actions = intent.options.map((o, i) => ({ id: `a${i}`, label: `Go to Surah ${o.name}`, description: `Show ${keys[i]}` }));
        const { state, questions } = buildCommandChoice(text, currentKey, actions);
        const d = await this.client.evaluate(state, questions, { timeoutMs: SEARCH_DEADLINE_MS, signal });
        const a = d.answers.action;
        if (a?.type === 'choice' && !a.tied && a.choice !== NO_ACTION && (a.probabilities[a.choice] ?? 0) >= 0.9) {
          confirmedKey = keys[Number(a.choice.slice(1))] ?? null;
          status = 'JEV suggested one surah; confirm before showing.';
        }
      } catch {
        status = 'Several surah names match; JEV unavailable. Choose one.';
      }
    }
    const cards = keys.map((k) => this.card(this.corpus.verse(k)!.index));
    return { kind: 'candidates', route: 'chapter', query: text, cards, confirmedKey, status };
  }

  async search(query: string, signal?: AbortSignal): Promise<CommandResult> {
    const lexical = this.bm25.search(query, LEXICAL_K);
    let semantic: Array<{ verseIndex: number }> = [];
    if (this.semantic?.ready) {
      try {
        semantic = await this.semantic.search(query, SEMANTIC_K);
      } catch {
        semantic = [];
      }
    }
    const fused = reciprocalRankFusion(semantic.length ? [lexical, semantic] : [lexical]).slice(0, TO_JEV);
    const trace: SearchTrace = {
      lexical: lexical.map((h) => h.verseIndex),
      semantic: semantic.map((h) => h.verseIndex),
      fused: fused.map((h) => h.verseIndex),
      jev: { outcome: 'not_called', latencyMs: null, choice: null },
    };
    this.lastTrace = trace;
    if (!fused.length) return { kind: 'no_match', message: `No passages in the ${this.corpus.data.manifest.translation.name} translation matched “${query}”. Try different words or a reference.` };

    let order = fused.map((f) => f.verseIndex);
    let confirmedKey: string | null = null;
    const retrieval = this.semantic?.ready ? 'lexical + semantic retrieval' : 'lexical retrieval (semantic search not set up)';
    let status = `Unconfirmed ${retrieval}.`;
    if (this.client) {
      const t0 = performance.now();
      try {
        const passages = order.map((i) => ({ key: this.corpus.at(i)!.key, english: this.corpus.at(i)!.english }));
        const { state, questions, kept } = buildSearchChoice(this.client.gateway, query, passages);
        const d = await this.client.evaluate(state, questions, { timeoutMs: SEARCH_DEADLINE_MS, signal });
        const pick = d.answers.passage;
        const rel = d.answers.relevant;
        trace.jev = { outcome: 'answered', latencyMs: Math.round(performance.now() - t0), choice: pick?.type === 'choice' ? pick.choice : null };
        if (pick?.type === 'choice' && rel?.type === 'noul') {
          if (pick.choice === NO_MATCH || rel.noul < 0.5) {
            status = `JEV found no passage that directly matches; showing ${retrieval} results.`;
          } else if (!pick.tied) {
            const idx = order.indexOf(this.corpus.verse(kept[Number(pick.choice.slice(1))].key)!.index);
            if (idx >= 0) {
              const [chosen] = order.splice(idx, 1);
              order = [chosen, ...order];
              confirmedKey = this.corpus.at(chosen)!.key;
              status = `JEV selected ${confirmedKey} from ${kept.length} retrieved passages. Other passages may also be relevant.`;
            }
          }
        }
      } catch (e) {
        trace.jev = { outcome: (e as { code?: string }).code ?? 'error', latencyMs: Math.round(performance.now() - t0), choice: null };
        status = `JEV unavailable (${trace.jev.outcome}); ${status}`;
      }
    }
    return { kind: 'candidates', route: 'search', query, cards: order.slice(0, CARDS).map((i) => this.card(i)), confirmedKey, status };
  }
}
