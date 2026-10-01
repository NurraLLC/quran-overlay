# Launch status — 2026-10-01

## Current update: charity stream scene

The owner explicitly approved deployment on October 1. Production now runs
`quran-reader:c889d26` (image `63449bc561c2`), with the existing content and state
volumes preserved. Sites routing is unchanged. `QO_TRUST_PROXY=1` and
`QO_MAX_LISTENERS=10` are configured. The content-refresh timer remains active.
Live payments remain disabled.

- Fresh source checks: TypeScript, all 271 unit/integration tests, production
  build and all 18 Edge browser tests passed. The image build passed all 25
  corpus checks covering 6,236 ayahs and 114 surahs. These are source/browser
  checks, not fresh replay or microphone measurements.
- Production container is healthy. Public health, policies, assets, anonymous
  session and control WebSocket checks passed. Direct origin access returns 404.
  The shared pool retained its pre-update totals: 276,923 funded seconds,
  2,378 used seconds, 108,391 available seconds and 166,154 reserve seconds.
- Live browser walkthrough: the Charity stream card appears; Al-Ikhlas displays
  in the stream panel; a temporary $1 donation announces and updates the total;
  removal restores $0 and zero donors; 2:282 displays Arabic and English part
  1 of 5. No microphone or paid recognition was started in this walkthrough.
- The previous container is retained as
  `quran-reader-old-48183d0-20261001T110836Z`. A private state archive and env
  backup were made in `/opt/quran-reader-backups` before the switch.
- The owner selected OBS Studio on this PC with the full charity scene. OBS is
  installed. Camera composition, the owner's microphone, phone QR scanning and
  a rendered OBS recording still require the owner test in [STREAM_TEST.md](STREAM_TEST.md).

The records below describe the original September 29 launch, not the current
image or new measurements.

## Original launch — 2026-09-29

**Public reader launched:** https://nurra.org/quran-reader/ . Sites version 14
(`fea5e1f`) forwards only the reader path to backend image
`quran-reader:48183d0`. Production deployment
`appgdep_6abc3065205c8191b753b01720b88939` succeeded with environment revision 1.
Live payments are explicitly disabled while the owner finishes Stripe.

Use this status before the older alternative deployment examples in LAUNCH.md.
The main Nurra website remains on Sites; Squarespace manages its DNS. Do not
migrate nameservers or buy another server.

## Verified

- Quran Foundation **Production** credentials authenticate and return 114 surahs.
- Authenticated content refresh completed on the approved DigitalOcean server:
  6,236 ayahs and 6,232 aligned word-gloss entries. A second refresh correctly
  reported unchanged content and renewed the checkpoint. The daily systemd
  timer is enabled. See [CONTENT_REFRESH.md](CONTENT_REFRESH.md).
- Source commits `c41fabf` (content refresh) and `ac8b077` (operating reserve)
  are pushed; both passed GitHub CI.
- The production-only lifecycle hook issue found during private startup is fixed
  in `6d9eddc`. Three real reader browser checks passed with the live freshness
  guard enabled. The host image uses the built `ac8b077` image plus that exact
  committed one-file fix; no provider credentials are inside the image.
- Local verification: typecheck, 208 tests, production frontend build, all ten
  browser checks, plus a focused hosted-flow rerun after the reserve change.
  Authenticated-content replay: 105 files, 805 ayahs, zero wrong ayahs and zero
  blank screens. Replay is not live microphone latency evidence.
- The $6 operating reserve is distinct from expenses and unavailable to new
  listening. A $10 allocation at 13 cents/hour leaves about 30.8 listening hours.
  This is an owner allocation, not a Stripe payment received.
- Private runtime `quran-reader-prelaunch` is healthy with generation
  `hafs-sync-5fa384339a8dfe90729ea578`. Authenticated external HTTPS and control
  WebSocket checks passed. The seeded ledger reads 276,923 funded seconds,
  166,154 reserved seconds, 110,769 available seconds and zero recorded usage or
  expenses. The owner allocation uses a stable ID to prevent duplicate grants.
  Soniox and OpenRouter are configured; live contributions remain off.

## Still needed for public launch

The public routing, reader policies and consent flow are now published. Remaining
operational verification and payment work:

- Test fairness from two distinct external networks. The proxy validates the
  trusted Cloudflare address and overwrites incoming forwarding headers; live
  multi-network quota isolation has not been measured.
- Confirm Stripe activation; install the live key and signed webhook only when
  available. Live contributions remain disabled. Test-mode funding is separate.
- Reconcile actual provider and hosting bills against the estimated ledger.
  Stripe fees are automatic; this is not yet a fully reconciled cash ledger.
- Test the owner's live microphone and rendered OBS output. Browser fixtures
  and relay handshake checks do not replace those tests.

## Public verification

- Public health, privacy, terms, styles, scripts and pool endpoints return 200.
  Assets stay under `/quran-reader/`. Anonymous sessions work with Secure,
  HttpOnly cookies; public control WebSocket receives a snapshot.
- Direct origin access without the private gateway token returns 404.
- Browser walkthrough opened Al-Fatihah with Arabic and English, showed the
  unchecked voice-consent dialog, cancelled it, and retained the reading page.
  No owner microphone audio was captured during this walkthrough.
- Privacy and terms are available at `/quran-reader/privacy.html` and
  `/quran-reader/terms.html`, with Quran Foundation attribution on About.
  The owner requested email-only contact, `ashfaq@nurra.org`. These pages describe
  implemented practices; publication is not legal certification or confirmation
  of all provider contracts.
- Local checks on `48183d0`: typecheck, 208 tests, build and ten browser tests pass;
  GitHub CI passed. Voice tests cover cancel before any audio, explicit unchecked
  consent, retry, protected relay and silence reopening using synthetic fixtures.
- Main homepage content exactly matches the pre-existing Sites static export.
  The public response adds only Cloudflare's delivery/challenge script; its
  changing bytes explain the raw HTML checksum difference.
- Screenshots: `artifacts/hosting/public-reader-live.png` and
  `artifacts/hosting/public-voice-consent.png` (ignored local proof).

Preserve unrelated local edits in the cookie-path and Cloudflare Worker changes;
they were not included in these commits. Keep all production settings, origin
tokens, SSH keys and content checkpoints private.
