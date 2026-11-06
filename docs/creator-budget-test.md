# Ppan dated one-shot budget test

This is an isolated, single budget update, **not** continuous Auto, account-wallet top-up, account-cap editing, ROI optimization, campaign creation or pause/resume.

## Owner approval, 7 November 2026

- Bangkok window: **2026-11-07 05:00 inclusive to 12:00 exclusive**.
- Creator advertiser `7666005333864644624`, TikTok account `7285935731820920833`.
- Campaign `1881130110195874`, budget THB3,000, ROI target30.
- When reported spend reaches THB2,400, update campaign budget once to THB3,600.
- Campaign/client-day ceiling THB10,000, policy revision1, 80% threshold / 20% increment.
- Owner explicitly confirmed no manual adjustment or other/native automation during this test window.
- Native-OFF evidence source: **OWNER_ATTESTATION**. API and read-only Creator UI observation remain **UNKNOWN**, not API-verified OFF. Any affirmative API ENABLED result blocks execution.
- A changed campaign/budget/ROI/original modification timestamp cancels eligibility. Never retarget another campaign.
- Account-wide allowance was THB3,443.54 in the preflight UI audit; it is separate from campaign budget. No account allowance or wallet change is authorized by this test.

## Configuration and deployment

Use a NEW random `CREATOR_BUDGET_TEST_KEY`, distinct from `CREATOR_READ_BRIDGE_KEY`, on both existing providers. Never commit either key. `CREATOR_BUDGET_TEST_ENABLED` must be exactly `true`; otherwise the channel stays OFF.

`CREATOR_BUDGET_TEST_PERMIT` is the identical JSON permit on Railway and Render. Required fields: permitId, clientId, exact Creator binding, campaignId, expectedBudgetMinor300000, targetBudgetMinor360000, capMinor1000000, policyRevision1, localDate2026-11-07, notBefore2026-11-06T22:00:00.000Z, expiresAt2026-11-07T05:00:00.000Z, nativeAutoBudgetVerifiedOfftrue, exclusiveWriterConfirmedtrue.

Deploy reviewed Railway source first, then the correct Render feature branch (not legacy main). Existing read keys, Shop OAuth/routes, report formulas, and legacy execution flags remain unchanged. Render environment changes can trigger a deployment even with auto-deploy OFF; verify its linked branch before changing variables.

## Execution and uncertain outcomes

Every60s, Render checks its read cache only as a trigger. Railway performs a new uncached account-wide spend read plus two fresh campaign-info reads before writing. The PostgreSQL ledger commits a unique permanent permit/day reservation before the only TikTok budget POST. No transaction is held over the network.

A timeout, crash, missing record or unknown result never authorizes another financial request. Recovery uses ledger GET and provider-read-only reconciliation. Merely seeing the target budget does not prove this system caused it. Unknown outcomes keep the local cap lock held, including across restarts, until authoritative release proof exists. No guessed rollback or resend.

Only the currently paired sole Ppan owner receives result notifications. Claims are durable and made before sending; uncertain notification delivery is not automatically retried. The private owner may still request fresh status through existing LINE commands.

After12:00, no new budget execution is allowed and the permit does not roll to another day. Existing uncertain operations may still be reconciled read-only. Success does not enable continuous Auto.
