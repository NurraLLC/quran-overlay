# Reader integration — October 2, 2026

Completed source integration for `NurraLLC/quran-reader`, originally remote
`main` at `d70946fffee5cdece8b4a31afa12f0588533e0a2`. The local `master`
checkout and its untracked guidance/research files were preserved while work
ran in `task-22/quran-reader` on `codex/reader-integration-20261002`.

## Integrated work

- Usability/privacy: `ffe786af989f6e7169ee3f444e0094a8ae090fe4`; see
  [finishing pass](READER_FINISHING_PASS.md).
- Motion: `f5a59577003e616043f48f6ea7191bf3afa4ccb1`; complete `base..head`
  reviewed, clean writer worktree and parent receipt confirmed. See
  [motion evidence and limits](READER_MOTION_POLISH.md).
- Integration correction: `2e2bf016c4c541fddfaa03cbd86dab535dbe2748`.
  The expanded browser suite reproduced HTTP 429 after twenty successful local
  owner-link exchanges. Valid capabilities now authenticate without consuming
  the failed-guess budget. Invalid tokens still receive 401, then 429, without
  an owner cookie. Host/origin checks and hosted authorization are unchanged.
  The new authorization regression failed before the correction and passes.
- The original reader tests now select Both before checking Arabic word targets.
  They otherwise inherited English mode from the motion tests' shared session;
  the initial combined run passed 37/39. No product language preference was reset.
- About describes online contributions conditionally; the existing disabled
  support state remains explicit. The decorative support arrow is an inline
  SVG with the existing accessible name, instead of a font-dependent character.
  Payment configuration is unchanged. Route lazy loading is a separate proposal.

## Fresh local evidence

| Check | Result |
|---|---|
| TypeScript and production frontend build | Pass |
| Source tests | 282/282, 44 files, no skips |
| Full Edge browser suite | 39/39, one worker, isolated port 4422 |
| Focused motion → reader and contribution flow | 14/14 |
| Corpus/font validation | 25/25; all 6,236 ayahs and 114 surahs |
| Preserved content byte comparison | 241 raw/processed/font/brand files match original and isolated copies |
| Additional Git byte comparison | Brand assets, icons, display encoding and source manifest match remote baseline |
| Secret checks | Staged and full history, five original local secret values and ten known formats; no matches |
| Offline repository-fixture replay | 56 files, 235 ayahs, zero wrong displays, zero blanks; two flipbacks and eighteen highlight gaps reported |

Processed corpus SHA-256 remains
`c678dd5d2ba8dcfd6a38abddf9622a0af6d6033d07a61ce401f597e62299c54b`.
Tests use placeholder keys, local stand-in providers and synthetic audio where
needed. No credentials, state, captures, licensed raw content or dependency
folders are staged. Detailed logs are ignored local evidence at
`task-22/quran-reader/artifacts/integration/`.

## Remote and operational boundaries

Before push, GitHub readback showed only `.github/workflows/ci.yml`, identical
to local blob `ff3f420dc5afa52c85e498852af1b37fe9d92aa5`, with main-push and
pull-request triggers. It validates source/corpus/build and an ephemeral test
container/proxy/pool; it does not publish or deploy. Repository hooks,
environments and deployments each returned zero. The documented live host
update is a separate manual container switch. Exact pushed SHA and its CI
conclusion belong to the integration owner's final receipt.

The existing production status in [LAUNCH_STATUS.md](LAUNCH_STATUS.md) is not
relabelled by this source integration. No production deployment, paid provider
call, new credential, payment activation or actual broadcast occurred.

Hosted audio relay, temporary transcript memory, optional local diagnostic text
capture, browser-held personal keys and separate charity-scene persistence
remain accurately disclosed. No universal provider zero-retention claim is made.
Offline replay and browser stand-ins do not prove owner-microphone latency or
native OBS output. Motion review used actual recorded frames and screenshots;
original-speed clips are retained, but subjective normal-speed playback was
unavailable through the image-only tool surface. Physical phone, screen-reader,
provider and native OBS verification remain separate.

All worktrees and their ignored evidence are retained. Main's untracked
`AGENTS.md`, `CLAUDE.md` and seven `outputs/` research/guidance files remain
outside the commits. No force push, reset or unknown-file cleanup is used.
