# Launch review — 2026-09-29

The product's useful promise is simple: open the Quran, recite, and keep your place without managing an interface. Preserve the large Arabic, source-owned meanings and quiet reading surface. The most valuable launch improvements were reliable recovery and honest funding boundaries, rather than more features.

## Repaired

- Shared listening admission now counts other visitors' outstanding reservations against both the pool and network share. Three regression cases cover simultaneous visitors, separate cookies on one network, and failed key minting. Personal-credit reservations are intentionally conservative; run one app instance.
- The production image includes the pool-funding script used by the launch instructions. CI now builds the image, starts it, funds one hour and reads the pool back, with providers disabled.
- Caddy trusts visitor-address headers only from Cloudflare's published ranges, then sends a single validated address to the app. Otherwise the default proxy configuration groups visitors under a CDN address and applies the same network quota to them.
- About-page return links stay inside `/quran-reader/`.
- Failed first loads offer retry. Failed surah loads keep the chosen reference and offer retry. Late responses from a previous surah cannot overwrite the new selection.
- The reader explains unavailable listening and reconnecting instead of inviting taps on a disabled microphone or leaving a failed request pending.
- Donation and launch wording distinguishes listening hours from provider spending. The Quran translation is explicitly attributed separately from the paraphrased hadith translations. Startup logs describe sponsored hours instead of the retired default allowance.

## Evidence from this review

| Layer | Result |
|---|---|
| Source | TypeScript passes; 192 unit/integration tests pass; production web build passes. |
| Corpus | 25/25 checks; all 6,236 ayahs and 114 surahs retained. No scripture, font or corpus changes. |
| Browser | Nine Edge tests pass, including first-load retry, surah retry and delayed-response cancellation. Hosted `/quran-reader/` inspected in the in-app browser; About links retain the prefix; phone reading and desktop overlay screenshots inspected. |
| Replay | 105 files, 805 ayahs; zero wrong ayahs and zero blank screens. The harness also reports 18 backward transitions and 70 highlight gaps. These were not individually adjudicated in this pass; do not describe this as flawless tracking. Its negative best-latency value makes the aggregate timing unsuitable for a new latency claim. |
| Proxy | Official Caddy 2.11.4 accepts the production Caddyfile locally and Caddy's container validates it in CI. A local HTTP check rejected forged visitor headers from a direct caller and forwarded a simulated trusted edge's visitor address. Live Cloudflare forwarding remains untested. |
| Container | The production Docker image built successfully in CI on `6208b8f`. The initial smoke check encountered a connection reset before the app was ready; its read-only health retry now covers that startup race. Require the complete start/fund/readback job to pass before deployment. |
| Provider / microphone / OBS | No new paid provider calls, owner microphone recitation, or OBS-native rendering in this review. Browser silence tests use a stand-in provider and non-recitation tone. |

## Launch dependencies

1. Server with persistent storage; Cloudflare account access and origin DNS.
2. Pass the container smoke check and verify WebSockets and distinct network quotas through Cloudflare.
3. Dedicated provider credentials with verified provider-side spending controls, and the owner's chosen starting pool hours.
4. Owner recitation through the deployed path, including silence/resume, and an OBS browser-source check.
5. Keep live donations disabled until the existing Quran Foundation confirmation requirement is satisfied; Stripe needs a separate test-mode flow.

The pool is **not a hard financial ceiling**. Audio goes directly to Soniox, whose invoice is token-based. The server accepts early-stop signals from the client and cannot prove a remote stream stopped; overlapping streams can also cost more than union-based user metering. Provider-side limits remain essential. See [Soniox pricing](https://soniox.com/pricing) and [deployment notes](DEPLOY.md).

Free signup does not imply suitable free production hosting: for example, [Render's free services](https://render.com/docs/free) sleep when idle and lack a persistent disk. Losing this app's state loses its pool ledger and visitor identity secret. Choose hosting before entering paid-service settings.
