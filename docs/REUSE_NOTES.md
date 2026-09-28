# Reuse notes: what came from Moard and Nur, and how it is verified here

Route followed: [`outputs/MOARD_REUSE_GUIDE.md`](../outputs/MOARD_REUSE_GUIDE.md). Moard (`C:\VibeBerry 97`) and Nur (`C:\Nur`) were read only; nothing was copied as a runtime dependency, no credentials or recordings were read, and no process was touched.

Sources read on 2026-09-28. Moard is an active checkout: HEAD was `bebab2bf73bc…` when read (the plan recorded `50d66816…`; it later showed `65df59b5…`). Nur backend HEAD `ba81f7985b75…`. Files: Moard `harbor/intelligence/{soniox_stream,openrouter_jev,jev,jev_turn,openrouter_http,contextual_rank_provider}.py` and tests, `harbor/actions/contextual_ranking.py` and test, skills `moard-motion-and-latency`, `moard-surface-quality`, `moard-cross-runtime-integrity`, `moard-agent-learning-loop` (`.claude/skills` mirror); Nur `app/ai/jev_{contracts,client,tasks,gateway,pricing}.py`. The command owners (`command_admission.py` etc.) were not needed: this app's action set is only navigation/search.

## Adapted patterns

| Source owner | Adapted here | Intentional divergence | Verified by |
|---|---|---|---|
| `soniox_stream.py` `_take` + tests (markers never typed; provisional replaced, never accumulated; finals exactly once; tokens joined by their own spaces) | `src/shared/transcript.ts` | Browser SDK transport instead of raw socket; no 40 s backlog queue; no per-breath finalize for recitation; the open final word counts as evidence so an ayah's last word does not wait for the next word (found in replay: it delayed every ayah end). | `tests/tracker/transcript.test.ts` (`<end>/<fin>` never words, replacement not append, repeated words kept) |
| `test_audio_before_a_finalize_is_sent_before_it`, `test_each_finalize_returns_only_that_breaths_final_words` | Push-to-talk lane bounded by provider audio timestamps (`src/web/audio/command-lane.ts`); manual finalize only after an explicit release | Recitation uses no manual finalize (endpointing is not an ayah boundary). Straddling words or Arabic inside the window → show text for correction, don't execute. | `tests/session/command-lane.test.ts` |
| `openrouter_jev.py` / `jev.py` request + strict parse (exact answer objects, open `usage`, two-decimal tolerance without renormalizing, ties are non-actions, error bodies never read, no retry, bounded sizes, redacted key) | `src/server/providers/jev.ts` | One interface over TypeSafe direct and OpenRouter. OpenRouter requests carry Nur's `provider: {only: [TypeSafe], allow_fallbacks: false, data_collection: deny}` pin (Moard sends no pin) for decision-primitive identity and privacy. Duplicate-key JSON detection not ported (JS `JSON.parse`). | `tests/providers/jev.test.ts` incl. ports of `test_a_metering_field_this_provider_has_not_shipped_yet_does_not_end_voice` and `test_two_decimal_rounding_keeps_reported_scores_without_normalization` |
| `jev_turn.py` independent questions in one request; `fit_candidates` on the serialized body | `buildLocate` (choice + independent `has_match` noul), `fitToBudget` | Options map to local candidates; WAIT always kept; incumbent/next/best-global placed first before trimming; truncation recorded. | Port of `test_an_oversized_pack_keeps_relevant_candidates_inside_the_actual_budget` |
| `contextual_ranking.py` single-flight, newest pending, coalescing, late-answer rejection, negative cache | `src/server/tracker/scheduler.ts` | Recitation-specific deadline (600 ms) and interval; rate-limit cooldown; cache is only negative (no answer reuse across evidence). | `tests/tracker/scheduler.test.ts`: ports of `…blocked_provider_never_blocks_select_and_identical_reads_are_singleflight`, `…latest_context_coalesces_while_old_provider_ignores_cancellation`, `…failed_or_invalid_ranking_is_negative_cached_without_poll_retry_spam` |
| `test_late_response_is_rejected_for_every_authority_change`; Nur `DecisionBinding` fingerprint + `current_for` | `Binding` in `follower.ts` (session, capture epoch, corpus, manual revision, mode revision, evidence span) + revalidation of the chosen candidate against the newest words | Appended evidence does not invalidate a result (it is re-aligned instead), as the plan requires; rewritten evidence/new epoch/manual seek/mode change do. | `tests/tracker/follower.test.ts` (manual seek, new capture epoch) |
| Candidate-coverage lesson ("a model choosing from 24 candidates cannot recover one retrieval omitted") | Full-corpus seeds + local window + collisions preserved; English recall reported before any reranking | — | `docs/ENGLISH_EVAL.md`, `docs/BENCHMARK.md` |
| cross-runtime-integrity: one contract owner | `src/shared/contracts.ts`; overlay, preview and reading screen share `VerseDisplay` | — | `tests/session/server.test.ts` (full state on connect, monotonic revisions, atomic verse) |
| motion-and-latency: stage timing, never compare unrelated clocks, "a repeated frame is not dispatched", "hold the last good frame" | Session publishes only real changes; overlay acknowledges after paint, server measures commit→paint round trip on its own clock; tracker compute measured per update | No device/video instruments here yet (no OBS capture ran). | Metrics on the control page; `docs/BENCHMARK.md` compute times |
| surface-quality + human-experience: operate complete flows and intermediate frames | Browser walkthrough with frame capture | — | `tests/ui/walkthrough.spec.ts`; review found and fixed: on-air monitor scrolling out of view after *Show on stream*, one label ("Show on stream") doing two jobs, false "still listening" copy, blank-then-reacquire flash on jumps |

Not carried over (Moard-specific): always-listening English TALK endpoint tuning, managed customer keys, the no-local-model rule (the optional MiniLM adapter here is this product's own, unmeasured experiment), phone/device policies, styling.

## Learning-loop record

| Friction | Cause | Correction | Proof | Durable owner |
|---|---|---|---|---|
| Wrong jump 36:4 → 67:23 | Words already explained by the current ayah (36:4 = end of 67:22) counted as evidence for the jump | Jumps need *fresh* evidence only | engine test "does not double-count…"; scenario `different-surah-jumps` | `reducer.ts` |
| Blank flash before re-acquiring after a jump | Old words outweighed new speech; clear timer fired first | Recency-weighted alignment; bounded "forming" grace | engine test "jumps … without a blank" | `align.ts`, `reducer.ts` |
| Hybrid made 8 wrong displays with a stand-in decider | A decision accepted a passage textually identical to others after two words | Collision check in revalidation; ask only after 3 fresh words | follower collision regression test; benchmark hybrid 0 wrong | `reducer.ts` `revalidate` |
| Silent-alif marks rendered as dotted circles | Display text and font use different encodings | Evidence-checked display re-encoding | `scripts/check-display-encoding.ts`, rendered mark sheet | `display-encoding.ts` |
| Isolation test pages "proved" correct rendering | file:// test pages silently fell back to a system font | Test glyphs only inside the served app with the font loaded | — (method note) | this record |

## Resource integration slices (docs/RESOURCE_INTEGRATION.md)

Each row: input → validated coverage → built index → actual caller → changed behaviour → measured result.

| Slice | Input | Coverage | Index | Caller | Behaviour change | Measured |
|---|---|---|---|---|---|---|
| Exact collisions (derived) | Imlaei text, all 6,236 ayahs | 3,771 shared 4-word phrases; 2,823 ayahs with ≥1 twin | `resources/phrases.ts` (24 ms build) | JEV locate evidence (`related_candidates`) | Decisions see which candidates are textual twins | Candidate-region use removed: 0 behaviour change, ~2.4× compute over 51 fixtures (`docs/BENCHMARK.md`) |
| Contextual revalidation | Real anchor/prior + fresh evidence | — | — | `follower.onOutcome` | Continuity breaks identical-text ties (3:2 vs 2:255 with anchor; 55:13 refrain); true collisions refused | `tests/tracker/revalidate.test.ts`; live JEV WAIT + local refusal on a 20-way opening |
| QUL similar/mutashabihat/topics/themes/divisions/QPC | Exports not yet downloaded (login required) | — | Importers + compiled artifacts | Tracker regions, search channel, navigation (wired, inactive without data) | Pending | Importer fixture tests only (`tests/resources/importers.test.ts`) |
| Live JEV for search | OpenRouter Decisions | — | — | `CommandResolver.search` (progressive, hedged) | JEV pick badged; retrieved cards shown at once | Frozen v2 first-card relevance 15/30 → 21–26/30 (uncontrolled provider conditions) |

Provider finding: OpenRouter Decisions intermittently stalled >10 s (no response byte) during testing; identical requests otherwise took ~0.3 s; reproduced with curl, so not a client fault. Recitation decisions keep their 600 ms deadline and fall back to deterministic results; only user-triggered search is hedged (one duplicate after 700 ms, never after rate-limit/auth errors).
