# Community project budget

Owner decision, 2026-09-29: start with a **$10 project budget**. This is a launch allocation, not a payment already received. Do not copy the sandbox's funded hours into production.

The community supports the whole Quran Reader project. Contributions add to the budget. Listening and project expenses reduce it. The public display uses hour equivalents; it must keep actual listening time separate from costs. A negative balance represents uncovered costs and prevents new listening.

## Current accounting and its limits

- The existing conversion is 13 US cents per hour equivalent (`QO_SPONSOR_CENTS_PER_HOUR`). This is a display/admission estimate, not a provider price guarantee. Keep it fixed for an existing ledger; changing it requires a reviewed conversion of historical balances.
- Connected listening time is deducted automatically as an estimate. It includes short pauses. Stripe contributions are added once after a verified paid webhook.
- Hosting, payment fees, AI, and other expenses can now be recorded with their actual USD amount and a private stable receipt ID. Corrections replace the same receipt; retries do not duplicate costs. Public totals expose no receipt IDs or contributor details.
- **Automatic expense imports are not connected yet.** Stripe fees are not currently deducted by the payment webhook. Provider billing and hosting invoices still require an import or operator entry. Do not describe this counter as an automatically reconciled cash balance.
- Do not enter the full recognition invoice as an additional expense: listening already reduced the pool. A production invoice reconciliation must replace the corresponding listening estimate, not add it twice. That reconciliation is still required for fully actual-cost accounting.
- Record only Quran Reader's attributable costs. Do not charge the entire Nurra site's costs to this pool unless that allocation is explicitly agreed.

## Record an additional cost

Use the service's actual `QO_STATE_DIR` and matching conversion rate. USD supports up to six decimal places; values are persisted as integer microdollars. The command records an accounting entry; it does not transfer money.

```sh
npx tsx scripts/project-cost.ts stripe-fee-receipt payment_fees 0.45
npx tsx scripts/project-cost.ts hosting-invoice-2026-10 hosting 5.00
```

Reuse the receipt ID to correct the amount. Entering zero reverses that receipt's debit while preserving the record. This is an operator command, not a public API.

## Hosting

The existing public Nurra Site is verified at `https://nurra.org`, version 13. Keep it intact. Its Sites runtime requires a Workers-compatible server build. Quran Reader currently uses Fastify, long-lived session state, and `node:sqlite` with a persistent volume. It cannot be deployed unchanged as a static subdirectory of that Site. Resolve a compatible backend deployment or port before public launch; a domain alone does not run this backend.
