# TikTok LIVE GMV Max API setup

Internal Dashboard work is intentionally out of scope for this branch. This
branch connects the existing LINE command center to TikTok API for Business and
keeps every TikTok mutation disabled until the account bindings pass a
read-only preflight.

## Confirmed app access

- App: `Whale Buddy Ads Automation`
- App ID: `7667234745498992657`
- Verification: Approved
- Required API groups are present:
  - Campaign read/create/update/status
  - GMV Max store, exclusive authorization, identity and bid recommendation
  - GMV Max reporting

Never paste the App Secret, access token, refresh token, LINE token, or
encryption keys into LINE, GitHub, config JSON, or chat.

## First authorization

1. In Render, enter `TIKTOK_APP_SECRET` as a secret.
2. Confirm these generated secrets exist:
   - `TIKTOK_OAUTH_STATE_SECRET`
   - `TIKTOK_TOKEN_ENCRYPTION_KEY`
3. In a private chat with the internal LINE OA, send `LINE ID ของฉัน`, then
   set `TIKTOK_OAUTH_ADMIN_LINE_USER_IDS` to that explicit LINE user ID of the
   agency owner. Do not use a client approver as an implicit OAuth admin.
4. Set `TIKTOK_API_CONTROL_ENABLED=true`.
5. Keep all mutation flags off:
   - `CONTROL_PLANE_ONLY=true`
   - `EXECUTION_ENABLED=false`
   - `MONITOR_ENABLED=false`
6. Deploy the branch.
7. In a private chat with the internal LINE OA, send:

   ```text
   เชื่อม TikTok API Ppan
   ```

8. Open the one-time TikTok button and authorize the agency account plus the
   relevant ad accounts.
9. Return to LINE and send:

   ```text
   ตรวจสอบ TikTok API Ppan
   ```

The callback never renders or sends a token. Tokens are encrypted with
AES-256-GCM before being stored on the Render persistent disk. Advertiser IDs
are mapped to one agency credential so the same agency grant can safely route
multiple client ad accounts.

If TikTok supplies an access-token expiry and the credential expires, the
read-only command fails closed and LINE asks the explicit agency admin to run
the authorization command again. Automatic refresh is not claimed in this
release.

## Read-only preflight

For the selected client, the preflight:

1. Confirms the OAuth grant contains the configured advertiser.
2. Reads `/advertiser/info/` and requires the configured currency, timezone,
   and an enabled advertiser account.
3. Reads `/gmv_max/store/list/`.
4. Requires exactly one GMV Max-capable shop with an `EFFECTIVE` exclusive
   authorization for the configured advertiser and Business Center.
5. Reads `/gmv_max/identity/get/`.
6. Keeps the browser-visible TikTok account ID separate from API `identity_id`
   and returns only identity candidates whose documented Business Center/Shop
   binding is in scope.
7. Reads at most 25 LIVE GMV Max campaign candidates for the Shop and preserves
   each candidate's `primary_status` for operator review.
8. Returns only:
   - `DISCOVERY_REQUIRED`
   - `BLOCKED`

No endpoint that changes TikTok is called during this flow.

The first successful preflight is still discovery, not authority to write.
The exact tuple of advertiser, Shop, authorized Business Center, API identity,
currency, timezone, and existing campaign (if any) must be shown and pinned
before a write-enabled executor is allowed.

## Future live executor contract

A later write-enabled release must retain a separate kill switch and require a
new LINE confirmation for the exact action. Official LIVE creation values are:

- `shopping_ads_type=LIVE`
- `optimization_goal=VALUE`
- `deep_bid_type=VO_MIN_ROAS`
- `schedule_type=SCHEDULE_FROM_NOW` or `SCHEDULE_START_END`
- a unique `request_id`

The executor must revalidate advertiser, shop, authorized Business Center,
identity, campaign occupancy, budget, ROI, schedule, approver, and policy
revision immediately before any POST, then read the campaign back. An unknown
POST outcome must be reconciled; it must never be blindly retried.
