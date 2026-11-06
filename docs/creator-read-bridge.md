# Ppan Creator API → LINE read bridge

This opt-in bridge replaces **report reads only** with verified Creator data.
It does not grant authority to create, pause, change budgets, or run Auto Top-up.

The report API retains its TikTok credentials. The LINE service receives only a
dedicated read key and normalized, Ppan-only observations over HTTPS:

`GET /internal/creator/punpan_020/snapshot`

Configure these service environment variables through the hosting secret store:

- `CREATOR_READ_ENABLED=true`
- `CREATOR_READ_URL=https://gmv-max-report-production-3251.up.railway.app/internal/creator/punpan_020/snapshot`
- `CREATOR_READ_BRIDGE_KEY`: the same dedicated random key configured on the API

Do not put a TikTok token, encryption key, or report database password in this
service. Do not reuse the general report internal key for this bridge.

The Creator read flag forces control-plane-only mode, disables the legacy
Chrome budget-alert worker and all execution/monitor workers, regardless of
legacy mutation environment flags. Existing legacy command templates remain
DRY-RUN. Existing Shop callback behavior is preserved.

## Read paths

The bridge polls every 60 seconds, beginning after startup. `สถานะ Ppan`,
`อัปเดต Report ล่าสุด`, and existing scheduled report subscriptions read its
cache. Financial controls and Auto Boost do **not** receive this cache and
continue using their separate, existing telemetry path.

The client validates the complete Ppan advertiser/TikTok/API-identity/BC binding,
allows GET only to the fixed HTTPS path, rejects redirects, limits response
bodies and time, and never logs raw errors or credentials. Missing, failed,
wrong-date, or older-than-three-minute observations are unavailable/stale and
never replaced by an old Chrome snapshot labelled as new API data.

Spend is an estimated daily report value, not a guaranteed zero-latency stream.
The report explicitly separates configured ROI Target from actual ROI. Missing
GMV, actual ROI, and LIVE views are shown as unverified, not zero. Native Auto
Budget is UNKNOWN unless the source confirms a supported state.

`/health` exposes only adapter state and observation time, never campaign money
or identifiers. Existing admin authentication protects:

- `GET /admin/creator-read`: current read observation
- `POST /admin/creator-read/refresh`: request a bounded read refresh

These endpoints cannot activate any advertising writer.

## Confirmed policy settings, still pending execution test

The Ppan policy is initialized once in SQLite with the current user-confirmed
80% threshold, 20% increase from the current budget, and THB 10,000 for both the
campaign ceiling and aggregate client/day ceiling. Mode remains
`AUTO_PENDING_TEST` and execution remains disabled. Restarting the service does
not reset a subsequently confirmed ceiling.

The paired owner can use these private LINE commands:

```text
ดูเพดาน Ppan
ตั้งเพดาน Ppan 10000
```

Setting a ceiling creates a 15-minute, owner-bound confirmation card. Only the
same currently paired owner may confirm it in private chat; stale revisions,
expired requests, replacement proposals, foreign users and group chats fail
closed. A confirmed change updates both ceilings together, but never changes a
TikTok budget or enables automation. Reply failures and webhook redelivery
recover using the same durable proposal/confirmation identity.

The checked-in legacy Ppan binding now uses the verified Creator advertiser
`7666005333864644624`, and its dated legacy guard is revision 2 from
2026-11-06. New Creator reports display the current persisted policy ceiling,
not a stale hardcoded ceiling. Old Chrome observations for a different
advertiser must not be accepted as the new Creator account's data.
