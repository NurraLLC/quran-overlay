# Reader finishing pass — October 2, 2026

Baseline: `d70946fffee5cdece8b4a31afa12f0588533e0a2`, confirmed `NurraLLC/quran-reader` in `C:\QuranOverlay`. Work is isolated on `codex/reader-usability-20261002`. No deployment or live account change.

## Verified corrections

Three browser regressions were reproduced before editing: a 503 response removed the entire surah picker; requesting the current ayah from Home reported “Opened” but stayed on Home; Tab escaped the purported modal Menu into language, reading and microphone controls.

- The surah picker keeps its heading, shows loading/failure, and retries in place. Unmounted requests are aborted.
- Successful typed navigation returns to reading even at the same reference. Private spoken search previews keep Home and the existing displayed ayah; the regression uses source-owned candidate text and simulated server messages, with no microphone/provider.
- Menu and existing listening sheets use native modal dialogs, contain focus, support Escape/backdrop dismissal, and restore a persistent opener. Reading appearance keeps its existing device-local behavior.
- The redundant second surah-loading message is removed. Requests have a compact provider-processing cue and readable Privacy link. Help/reporting is a separate Menu link to the public issue tracker; no issue was submitted.
- Welcome and About share mode-safe audio/transcript disclosures. Pending or failed mode discovery uses neutral wording, preventing a hosted reader from briefly claiming direct browser-to-Soniox routing.
- Conditional silence wording replaces universal “only while you speak”/“nothing during long pauses” promises. Existing consent actions and the anonymous charity-entry path are preserved.

The normal reading composition, Nurra assets, Arabic and translations are unchanged. No recitation was generated. No funding capability was added or activated.

## Independent critique

Separate read-only reviewers checked privacy boundaries and the implementation/actual before-after captures. Corrections from that loop: private spoken previews must not be treated as navigation; closed dialogs must stay hidden before `showModal`; links need the existing readable gold token; sheet-to-sheet dismissal needs a stable focus fallback. No remaining material finding at handoff. Physical-device feel, live speech/provider latency and native OBS rendering are separate, unverified layers.

## Evidence

Before/after 390 × 844 browser screenshots are in `C:\Users\ashfa\Documents\Codex\2026-10-02\task-9\evidence\before` and `...\evidence\after`: `surahs-failed.png`, `reopen-current.png`, `menu.png`, plus the new typed-query cue and About disclosure. Local browser flow recordings are in `...\evidence\browser-flows`. They are verification artifacts, not a new promotional video or production capture.

15/15 relevant browser checks pass: recovery, repeated requests, private spoken preview, keyboard focus and sheet transitions, hosted disclosure pending/failure, Help/Privacy cues, 320 px consent/touch targets, tap-word meanings, translation switches, scroll following, maximum reading size, reload persistence, and independent stream appearance. Recordings include the existing reader interactions at normal motion and source-owned simulated transcript following; screenshot/frame inspection is browser evidence, not physical-device or live-recitation proof.

Corpus and font pass 25/25 validation checks, including all 6,236 ayahs / 114 surahs and pinned source hashes. The isolated processed corpus is byte-identical to the original: SHA-256 `c678dd5d2ba8dcfd6a38abddf9622a0af6d6033d07a61ce401f597e62299c54b`.

Focused offline source checks: 23 tests across VAD, own-key relay, hosted speech, payment fixtures, stream state and dozing. TypeScript and the local production build pass. Browser tests use placeholder provider keys and one worker. An intermediate run hit disk exhaustion; only this task’s duplicated ONNX dependencies were replaced by read-only links, then checks were rerun.

## Privacy and contribution facts for launch copy

Source audit references below use the baseline revision; deployed configuration/provider-account settings were not inspected.

| Boundary | Actual source behavior |
|---|---|
| Audio | Hosted audio, including optional personal-key listening, passes through Nurra’s relay. Self-hosted audio goes directly to Soniox. `src/server/app.ts`, `providers/hosted-speech.ts`, `src/web/audio/soniox-session.ts`. |
| Retention | Public hosted startup disables diagnostic transcript files; recognised words remain temporarily in session memory. Self-hosted diagnostic capture can save recognised text. `src/server/main.ts:151`, `sessions.ts:585`, `sessions.ts:847`. |
| Silence | About eight seconds after detected speech can close the recognition stream. Initial silence, unavailable voice detection, command capture and reset states can leave it open. `audio/vad.ts:17`, `audio/mic.ts:222`, `audio/soniox-session.ts:197`, `audio/soniox-session.ts:834`. |
| Matching | Recognised words and typed queries can reach bounded matching requests. OpenRouter pins TypeSafe, disables fallback and requests `data_collection: deny`; this does not establish all-provider zero retention. `providers/jev.ts:74`, `providers/decisions.ts`, `commands/listening.ts`. |
| Personal key | Browser localStorage retains it until Remove/site-data clearing. Each new stream sends it to the relay, which holds it temporarily in memory; no server disk/log persistence path found. Remove affects future streams; Stop closes the current one. `audio/soniox-session.ts:137`, `providers/hosted-speech.ts:278`, `Control.tsx` OwnKey. No actual stored key was inspected. |
| Nurra contributions | Checkout uses `mode: payment`, one item, and explicit voluntary one-time, non-tax-deductible project support. Verified webhook fixtures grant the shared pool, not donor access. No current subscription/personal purchase or paid dataset resale flow found. Legacy paid-credit fields remain. `billing/stripe.ts:40`, `app.ts:357`, `Sponsor.tsx`, `public/terms.html`. No transaction/account call was made. |
| Creator charity scene | Separate creator-entered names/messages/amounts persist with scene settings. Empty name stays anonymous. The same private view token receives recent scene data, including amounts visually hidden by a display toggle. `sessions.ts:223`, `sessions.ts:515`, `app.ts:597`, `billing/overlay-links.ts`. The privacy notice now discloses this separately from Nurra contribution records. |

Soniox’s published real-time processing description distinguishes transient content from retained operational metadata: [security documentation](https://soniox.com/docs/security-and-privacy), [privacy policy](https://soniox.com/policies/privacy-policy). OpenRouter documents separate collection and retention controls: [data handling](https://openrouter.ai/docs/guides/privacy/data-collection). These policies support careful boundaries, not a blanket promise covering every provider setting.

## Video handoff

The existing task-5 Quran Reader capture used the same baseline. This change preserves the filmed normal reading appearance, source text, icon and wordmark. Newly changed states are Menu focus/Help, typed-query disclosure, recovery and privacy copy. No shared desktop/native UI, emulator, active local app restart, broadcast or video asset modification occurred. Parent/video thread tools were unavailable in this execution environment; early status and the final stable commit are recorded in the task’s `QURAN_READER_COORDINATION.md`.
