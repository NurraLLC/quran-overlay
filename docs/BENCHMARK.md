# Tracker replay benchmark

Generated 2026-09-28T12:30:39.803Z by `npm run benchmark -- --manifest fixtures/benchmark.json` on this machine.

**What this is:** the three tracker modes replayed over identical provider event streams in virtual time.
**What this is not:** a live latency or accuracy result. All streams below are corpus-derived synthetic Soniox-like token streams with assumed timing (final tokens 700 ms after each word, provisional 150 ms) and, for the `noisy-*` fixtures, assumed ASR error rates. Decision calls in `hybrid` and `jev_required` use a simulated client with a fixed 350 ms latency that always picks the top-ranked local candidate — it is **not JEV** and says nothing about JEV accuracy on Arabic. No microphone, Soniox, JEV or OBS measurement is included.

| Mode | Decisions | Runs | Ayahs shown / recited | Wrong displays | Clears | Runs failing expectations | Onset→display p50 / p95 (ms, assumed timing) | Words heard before display p50 | Decision calls | Tracker compute p50 / p95 (ms, measured) |
|---|---|---|---|---|---|---|---|---|---|---|
| deterministic | none | 19 | 168 / 178 | 0 | 1 | 0 | 1295 / 2265 | 3 | 0 | 2.48 / 3.70 |
| hybrid | simulated (350 ms; NOT JEV) | 19 | 168 / 178 | 0 | 1 | 0 | 1295 / 2265 | 3 | 17 | 2.57 / 3.49 |
| jev_required | simulated (350 ms; NOT JEV) | 19 | 155 / 178 | 0 | 4 | 3 | 1745 / 2715 | 4 | 279 | 2.55 / 3.34 |

## Per fixture

| Fixture | Mode | Shown / recited | Wrong | Clears | Onset→display p50 (ms) | Calls | Expectations |
|---|---|---|---|---|---|---|---|
| common-opening | deterministic | 3 / 3 | 0 | 0 | 1350 | 0 | pass |
| common-opening | hybrid | 3 / 3 | 0 | 0 | 1350 | 2 | pass |
| common-opening | jev_required | 3 / 3 | 0 | 0 | 1800 | 6 | pass |
| different-surah-jumps | deterministic | 11 / 12 | 0 | 0 | 1240 | 0 | pass |
| different-surah-jumps | hybrid | 11 / 12 | 0 | 0 | 1240 | 1 | pass |
| different-surah-jumps | jev_required | 9 / 12 | 0 | 1 | 1635 | 17 | never showed 112:1; 1 clears > 0 |
| english-commentary | deterministic | 6 / 7 | 0 | 1 | 1240 | 0 | pass |
| english-commentary | hybrid | 6 / 7 | 0 | 1 | 1240 | 0 | pass |
| english-commentary | jev_required | 3 / 7 | 0 | 1 | 1690 | 34 | final display null ≠ expected 19:7; never showed 19:5 |
| fatiha-to-baqarah | deterministic | 11 / 12 | 0 | 0 | 1295 | 0 | pass |
| fatiha-to-baqarah | hybrid | 11 / 12 | 0 | 0 | 1295 | 3 | pass |
| fatiha-to-baqarah | jev_required | 11 / 12 | 0 | 0 | 1745 | 14 | pass |
| letter-names | deterministic | 3 / 4 | 0 | 0 | 1350 | 0 | pass |
| letter-names | hybrid | 3 / 4 | 0 | 0 | 1350 | 0 | pass |
| letter-names | jev_required | 3 / 4 | 0 | 0 | 1800 | 4 | pass |
| longest-ayah | deterministic | 3 / 3 | 0 | 0 | 1240 | 0 | pass |
| longest-ayah | hybrid | 3 / 3 | 0 | 0 | 1240 | 0 | pass |
| longest-ayah | jev_required | 3 / 3 | 0 | 0 | 1690 | 3 | pass |
| manual-correction | deterministic | 5 / 6 | 0 | 0 | 1240 | 0 | pass |
| manual-correction | hybrid | 5 / 6 | 0 | 0 | 1240 | 0 | pass |
| manual-correction | jev_required | 5 / 6 | 0 | 0 | 1690 | 6 | pass |
| mid-ayah-start | deterministic | 2 / 2 | 0 | 0 | 1670 | 0 | pass |
| mid-ayah-start | hybrid | 2 / 2 | 0 | 0 | 1670 | 0 | pass |
| mid-ayah-start | jev_required | 2 / 2 | 0 | 0 | 2120 | 3 | pass |
| noisy-baqarah-11 | deterministic | 11 / 12 | 0 | 0 | 1295 | 0 | pass |
| noisy-baqarah-11 | hybrid | 11 / 12 | 0 | 0 | 1295 | 0 | pass |
| noisy-baqarah-11 | jev_required | 11 / 12 | 0 | 0 | 1745 | 14 | pass |
| noisy-baqarah-12 | deterministic | 11 / 12 | 0 | 0 | 1295 | 0 | pass |
| noisy-baqarah-12 | hybrid | 11 / 12 | 0 | 0 | 1295 | 0 | pass |
| noisy-baqarah-12 | jev_required | 11 / 12 | 0 | 0 | 1745 | 14 | pass |
| noisy-baqarah-13 | deterministic | 11 / 12 | 0 | 0 | 1295 | 0 | pass |
| noisy-baqarah-13 | hybrid | 11 / 12 | 0 | 0 | 1295 | 0 | pass |
| noisy-baqarah-13 | jev_required | 11 / 12 | 0 | 0 | 1745 | 13 | pass |
| noisy-kahf-11 | deterministic | 10 / 10 | 0 | 0 | 1295 | 0 | pass |
| noisy-kahf-11 | hybrid | 10 / 10 | 0 | 0 | 1295 | 1 | pass |
| noisy-kahf-11 | jev_required | 10 / 10 | 0 | 0 | 1745 | 13 | pass |
| noisy-kahf-12 | deterministic | 10 / 10 | 0 | 0 | 1295 | 0 | pass |
| noisy-kahf-12 | hybrid | 10 / 10 | 0 | 0 | 1295 | 1 | pass |
| noisy-kahf-12 | jev_required | 10 / 10 | 0 | 0 | 1745 | 15 | pass |
| noisy-kahf-13 | deterministic | 10 / 10 | 0 | 0 | 1240 | 0 | pass |
| noisy-kahf-13 | hybrid | 10 / 10 | 0 | 0 | 1240 | 1 | pass |
| noisy-kahf-13 | jev_required | 10 / 10 | 0 | 0 | 1690 | 13 | pass |
| refrain-55 | deterministic | 24 / 25 | 0 | 0 | 1295 | 0 | pass |
| refrain-55 | hybrid | 24 / 25 | 0 | 0 | 1295 | 0 | pass |
| refrain-55 | jev_required | 24 / 25 | 0 | 0 | 1745 | 27 | pass |
| repeat-previous | deterministic | 7 / 7 | 0 | 0 | 1295 | 0 | pass |
| repeat-previous | hybrid | 7 / 7 | 0 | 0 | 1295 | 1 | pass |
| repeat-previous | jev_required | 5 / 7 | 0 | 0 | 1745 | 19 | pass |
| same-surah-jump | deterministic | 4 / 5 | 0 | 0 | 1350 | 0 | pass |
| same-surah-jump | hybrid | 4 / 5 | 0 | 0 | 1350 | 4 | pass |
| same-surah-jump | jev_required | 4 / 5 | 0 | 0 | 1800 | 10 | pass |
| short-surahs | deterministic | 21 / 21 | 0 | 0 | 1240 | 0 | pass |
| short-surahs | hybrid | 21 / 21 | 0 | 0 | 1240 | 2 | pass |
| short-surahs | jev_required | 15 / 21 | 0 | 2 | 1745 | 49 | never showed 110:1; never showed 112:1 |
| silence | deterministic | 5 / 5 | 0 | 0 | 1240 | 0 | pass |
| silence | hybrid | 5 / 5 | 0 | 0 | 1240 | 1 | pass |
| silence | jev_required | 5 / 5 | 0 | 0 | 1690 | 5 | pass |

Onset→display is measured from the end of the first word of each recited ayah to the moment that ayah is first shown, using the synthetic stream's assumed provider timing; it includes waiting for enough distinguishing words. "Wrong displays" counts commits of an ayah that was not among the last 12 recited words. Tracker compute is real wall-clock time on this machine per material update.
