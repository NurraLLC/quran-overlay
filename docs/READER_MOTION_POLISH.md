# Reader and overlay motion polish — October 2, 2026

Base: `ffe786a`. Isolated branch: `codex/reader-motion-20261002`. The previous
navigation, recovery, native-dialog focus and privacy work remains intact.

## What changed and why

1. **Reader dialogs:** the Menu/Listening sheet and reading-appearance dialog
   settle for 180 ms with `cubic-bezier(0.2, 0.7, 0.2, 1)`. They start at 94%
   opacity so controls remain readable from the first frame. The phone sheet
   starts 12 px above its final position, inside the viewport; centered desktop
   and appearance dialogs start 6 px below. The backdrop settles over 120 ms.
   Dismissal remains immediate, using the existing native-dialog lifecycle.
2. **Choice feedback:** only language-button background/foreground (120 ms)
   and theme-choice border (140 ms) settle. Selection semantics, persisted state,
   the page theme and translation layout update immediately. Quran text and
   meanings receive no new transition.
3. **Overlay continuity:** removed the forward-ayah entrance that started the
   entire verse at 60% size, 150 px down and 45% opacity, plus its delayed next
   preview entrance. New Arabic, English and reference now appear together at
   the measured reading size. Passage mounting, word highlighting, pagination,
   alignment, preview/OBS/charity renderer sharing and hide/unhide are preserved.

All added motion exists only under `prefers-reduced-motion: no-preference`.
Changing that preference during an entrance removes the animation immediately.
There are no new timers, animation libraries, loops, content assets or features.

## Evidence

Local, ignored evidence is in `artifacts/reader-motion/index.html`: normal-speed
before/after clips for the 390 × 844 phone reader, 1280 × 900 desktop reader and
1920 × 1080 browser overlay, frame sheets, clip/source checksums and content
receipts. Original WebM captures are preserved in `test-results/`.
MP4 exports preserve timestamps; phone exports crop only blank recorder padding.
Captures contain manual navigation and UI choices, without audio or fake speech.
The overlay baseline used the unchanged base renderer/overlay CSS alongside
the first reader-control CSS refinement; the reader baseline used the base build.

The baseline overlay regression failed as intended. Its first changed sample
was `matrix(0.6, 0, 0, 0.6, 0, 150)` with opacity `0.45`. All 41 changed samples
had an entrance animation. In the reviewed run, all 42 changed samples had
transform `none`, opacity `1`, animation `none` and the new source translation.
These requestAnimationFrame samples establish rendered state, not performance
or microphone-to-display latency.

A closer phone check found 11 px of temporary outer dialog overflow in the first
implementation. Keeping the sheet's starting position inside the viewport fixed
it; the regression now checks active entrance, zero outer overflow, cancellation,
reopening, Tab/Shift+Tab containment, backdrop dismissal and focus return.

Frame sheets and settled screenshots were inspected. This environment exposes
image inspection but no video playback tool, so subjective normal-speed playback
review is still a limit; the actual clips are retained at their original speed.

## Validation and limits

- All 281 existing unit/integration tests in 44 files passed.
- All 9 new motion browser tests passed in installed Edge.
- All 19 affected existing browser tests passed: reader, usability, 320 px phone,
  recovery, reading/scene and overlay appearance. This is not the complete UI suite.
- Typecheck, production build and diff whitespace checks passed.
- Corpus validation: 25/25, including all 6,236 ayahs, all 114 surahs, source
  hashes and complete font codepoint coverage. Corpus, meanings, transliteration,
  font and display-encoding bytes match the recorded pre-change hashes.
- The separate existing QPC sample diagnostic ran on 1,923 verses and still
  reports source/encoding differences; it is diagnostic, not a new all-source
  equality claim. No encoding or scripture changes were made.
- No provider, physical microphone, native OBS, screen-reader, physical phone,
  low-end device or live production proof is claimed. No public-site copy changed.

The production bundle adds about 0.39 kB of CSS before compression and removes
about 0.26 kB of JavaScript, relative to the base build. No performance gain is
claimed from those sizes. The owning source files are `src/web/styles/app.css`
and `src/web/VerseDisplay.tsx`; browser invariants live in
`tests/ui/reader-motion.spec.ts`.

The dedicated integration owner must integrate this commit and run combined
checks before the authorized shared-main push. This worker does not merge, push,
deploy or remove its preserved worktree/evidence before integration receipt.
