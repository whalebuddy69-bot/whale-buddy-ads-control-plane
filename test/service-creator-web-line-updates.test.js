import assert from "node:assert/strict";
import test from "node:test";
import { BudgetGuardService } from "../src/service.js";
import { CREATOR_BINDING } from "../src/creator-read.js";

const AT_NOON = new Date("2025-03-15T05:02:00.000Z");
const ID = "punpan_020";

function harness({ enabled = true, now = AT_NOON, owners = 1, stale = false, oldSubscription = false,
  notice, fail = false, noActiveCampaign = false } = {}) {
  let nowValue = now;
  const state = { pushes: [], claims: 0, digests: new Set() };
  const client = { id: ID, advertiserId: CREATOR_BINDING.advertiserId, lineControl: { enabled: true },
    campaignSelector: { expectedTikTokAccountId: CREATOR_BINDING.tiktokAccountId } };
  const creatorRead = { supports: (id) => id === ID, getReadSnapshot: () => ({ stale, snapshot: {
    source: "tiktok-creator-api", readOnly: true, reportingDate: "2025-03-15", unavailable: false, noActiveCampaign,
    advertiserId: CREATOR_BINDING.advertiserId, tiktokAccountId: CREATOR_BINDING.tiktokAccountId,
    dailyBudgetMinor: 264000, costMinor: 173815, targetRoi: 12
  } }) };
  const store = { listLineApprovers: () => Array.from({ length: owners }, (_, i) => ({ lineUserId: `U-fixture-${i}`, active: true })),
    claimCreatorWebLineNotices() { state.claims++; if (notice && state.claims === 1) return [notice]; return []; },
    getReportSubscription: () => ({ enabled: oldSubscription }), reserveCreatorWebDigest({ slot }) {
      if (state.digests.has(slot)) return false;
      state.digests.add(slot);
      return true;
    } };
  const service = new BudgetGuardService({ config: { clients: [client] }, store, creatorRead, creatorWebLineUpdatesEnabled: enabled,
    line: { async push(to, msg, key) { state.pushes.push({ to, msg, key }); if (fail) throw new Error("ambiguous fixture"); } },
    tiktok: new Proxy({}, { get() { assert.fail("no TikTok write adapter permitted"); } }),
    now: () => nowValue, logger: { info() {} } });
  return { service, state, setNow: (value) => { nowValue = new Date(value); } };
}

test("digest is owner-only, twice daily Bangkok, tagged with the dashboard link, and deduplicated", async () => {
  const h = harness();
  assert.equal((await h.service.processCreatorWebLineUpdates())[0].status, "LINE_ACCEPTED");
  assert.equal((await h.service.processCreatorWebLineUpdates()).length, 0);
  h.setNow("2025-03-15T14:02:00.000Z");
  assert.equal((await h.service.processCreatorWebLineUpdates())[0].status, "LINE_ACCEPTED");
  assert.equal((await h.service.processCreatorWebLineUpdates()).length, 0);
  assert.equal(h.state.pushes.length, 2);
  for (const { to, msg } of h.state.pushes) {
    assert.equal(to, "U-fixture-0");
    assert.match(msg.text, /1,738\.15/);
    assert.match(msg.text, /ROI Target: 12/);
    assert.match(msg.text, /https:\/\/report\.whalebuddy69\.com\/automation/);
  }
  assert.notEqual(h.state.pushes[0].key, h.state.pushes[1].key);
});

test("flags off, no sole owner, stale reads, or existing subscription do not start a new digest", async () => {
  for (const options of [{ enabled: false }, { owners: 0 }, { owners: 2 }, { stale: true }, { oldSubscription: true },
    { now: new Date("2025-03-15T05:18:00.000Z") }]) {
    const h = harness(options);
    assert.deepEqual(await h.service.processCreatorWebLineUpdates(), []);
    assert.equal(h.state.pushes.length, 0);
    assert.equal(h.state.digests.size, 0);
  }
});

test("unknown web outcome is never reported as success; a failed delivery is not replayed", async () => {
  const h = harness({ now: new Date("2025-03-15T06:00:00.000Z"), fail: true,
    notice: { operationId: "5035df00-1801-4d02-8051-01affbbefdc9", outcome: "OUTCOME_UNKNOWN" } });
  assert.equal((await h.service.processCreatorWebLineUpdates())[0].status, "LINE_UNCONFIRMED");
  assert.deepEqual(await h.service.processCreatorWebLineUpdates(), []);
  assert.equal(h.state.pushes.length, 1);
  assert.match(h.state.pushes[0].msg.text, /ยังยืนยันผล/);
  assert.doesNotMatch(h.state.pushes[0].msg.text, /สำเร็จ/);
});
