import assert from "node:assert/strict";
import test from "node:test";
import { buildConfigIndex, validateConfig } from "../src/config.js";

function validInput() {
  return {
    agencyId: "agency",
    clients: [{
      id: "client",
      name: "Client",
      lineApproverUserIds: ["U1"],
      advertiserId: "adv",
      storeId: "shop",
      storeAuthorizedBcId: "bc",
      timezone: "Asia/Bangkok",
      campaigns: [{
        id: "cmp",
        name: "LIVE",
        currency: "THB",
        maxDailyBudget: 50000,
        maxIncreasePercent: 100,
        suggestionMultiplier: 1.5,
        minIncrease: 1000
      }]
    }]
  };
}

function validDynamicClient(overrides = {}) {
  return {
    id: "dynamic-client",
    name: "Dynamic Client",
    lineApproverUserIds: ["U2"],
    advertiserId: "dynamic-adv",
    storeId: "dynamic-shop",
    storeAuthorizedBcId: "dynamic-bc",
    timezone: "Asia/Bangkok",
    liveWindow: { start: "06:00", end: "23:00" },
    warningThreshold: 0.8,
    campaignSelector: {
      kind: "active-live-gmv-max",
      currency: "THB",
      expectedTikTokAccountId: "7285935731820920833",
      requireExactlyOne: true
    },
    budgetIncrease: {
      presetPercent: 20,
      allowManualTarget: true
    },
    budgetPolicy: {
      maxDailyBudget: 6000,
      effectiveFrom: "2026-07-19",
      revision: 1
    },
    ...overrides
  };
}

function dynamicInput(overrides = {}) {
  return {
    agencyId: "agency",
    clients: [validDynamicClient(overrides)]
  };
}

test("config normalizes the safe pilot defaults", () => {
  const config = validateConfig(validInput());
  assert.equal(config.agencyId, "agency");
  assert.equal(config.reconciliationWindowMinutes, 15);
  assert.equal(config.clients[0].storeAuthorizedBcId, "bc");
  assert.equal(config.clients[0].linePairingEnabled, false);
  assert.equal(config.clients[0].warningThreshold, 0.7);
  assert.equal(Object.hasOwn(config.clients[0], "shopBinding"), false);
  assert.equal(Object.hasOwn(config.clients[0], "telemetry"), false);
});

test("pilot config requires a Business Center identity and THB", () => {
  const missingBc = validInput();
  delete missingBc.clients[0].storeAuthorizedBcId;
  assert.throws(() => validateConfig(missingBc), /storeAuthorizedBcId/);

  const wrongCurrency = validInput();
  wrongCurrency.clients[0].campaigns[0].currency = "USD";
  assert.throws(() => validateConfig(wrongCurrency), /must be THB/);
});

test("dynamic selector config normalizes the LIVE window and budget policy", () => {
  const client = validateConfig(dynamicInput()).clients[0];

  assert.deepEqual(client.campaignSelector, {
    kind: "active-live-gmv-max",
    currency: "THB",
    expectedTikTokAccountId: "7285935731820920833",
    requireExactlyOne: true
  });
  assert.deepEqual(client.liveWindow, { start: "06:00", end: "23:00" });
  assert.equal(client.warningThreshold, 0.8);
  assert.deepEqual(client.budgetIncrease, { presetPercent: 20, allowManualTarget: true });
  assert.deepEqual(client.budgetPolicy, {
    maxDailyBudget: 6000,
    effectiveFrom: "2026-07-19",
    revision: 1
  });
  assert.equal(Object.hasOwn(client, "campaigns"), false);
});

test("static campaigns and a dynamic selector are mutually exclusive", () => {
  const input = dynamicInput({
    campaigns: [{ id: "cmp", name: "LIVE", currency: "THB", maxDailyBudget: 6000 }]
  });
  assert.throws(() => validateConfig(input), /mutually exclusive/);

  const missingBranch = validInput();
  delete missingBranch.clients[0].campaigns;
  assert.throws(() => validateConfig(missingBranch), /exactly one of campaigns or campaignSelector/);
});

test("dynamic selector requires an exact selector and executable identities", () => {
  for (const key of ["advertiserId", "storeId", "storeAuthorizedBcId"]) {
    const client = validDynamicClient();
    delete client[key];
    assert.throws(() => validateConfig({ clients: [client] }), new RegExp(key));
  }

  assert.throws(
    () => validateConfig(dynamicInput({ campaignSelector: {
      ...validDynamicClient().campaignSelector,
      kind: "latest-campaign"
    } })),
    /kind must be active-live-gmv-max/
  );
  assert.throws(
    () => validateConfig(dynamicInput({ campaignSelector: {
      ...validDynamicClient().campaignSelector,
      requireExactlyOne: false
    } })),
    /requireExactlyOne must be true/
  );
});

test("observe-and-pin with chrome-ui telemetry is the only storeless client branch", () => {
  const input = dynamicInput({
    shopBinding: { mode: "observe-and-pin" },
    telemetry: { source: "chrome-ui", browserProfile: "Whalebuddy Ads", tabGroup: "Ppan" }
  });
  delete input.clients[0].storeId;
  delete input.clients[0].storeAuthorizedBcId;

  const client = validateConfig(input).clients[0];
  assert.deepEqual(client.shopBinding, { mode: "observe-and-pin" });
  assert.deepEqual(client.telemetry, {
    source: "chrome-ui",
    browserProfile: "Whalebuddy Ads",
    tabGroup: "Ppan"
  });
  assert.equal(Object.hasOwn(client, "storeId"), false);
  assert.equal(Object.hasOwn(client, "storeAuthorizedBcId"), false);

  const noBinding = structuredClone(input);
  delete noBinding.clients[0].shopBinding;
  delete noBinding.clients[0].telemetry;
  assert.throws(() => validateConfig(noBinding), /may be absent only/);
});

test("observe-and-pin schema rejects partial or inexact authority declarations", () => {
  assert.throws(
    () => validateConfig(dynamicInput({ shopBinding: { mode: "observe-and-pin" } })),
    /must be configured together/
  );
  assert.throws(
    () => validateConfig(dynamicInput({ telemetry: {
      source: "chrome-ui",
      browserProfile: "Whalebuddy Ads",
      tabGroup: "Ppan"
    } })),
    /must be configured together/
  );
  assert.throws(
    () => validateConfig(dynamicInput({
      shopBinding: { mode: "manual" },
      telemetry: { source: "chrome-ui", browserProfile: "Whalebuddy Ads", tabGroup: "Ppan" }
    })),
    /mode must be observe-and-pin/
  );
  assert.throws(
    () => validateConfig(dynamicInput({
      shopBinding: { mode: "observe-and-pin" },
      telemetry: { source: "tiktok-api", browserProfile: "Whalebuddy Ads", tabGroup: "Ppan" }
    })),
    /source must be chrome-ui/
  );

  const partialIdentity = dynamicInput({
    shopBinding: { mode: "observe-and-pin" },
    telemetry: { source: "chrome-ui", browserProfile: "Whalebuddy Ads", tabGroup: "Ppan" }
  });
  delete partialIdentity.clients[0].storeId;
  assert.throws(() => validateConfig(partialIdentity), /must both be present or both be absent/);

  for (const missing of ["browserProfile", "tabGroup"]) {
    const telemetry = {
      source: "chrome-ui",
      browserProfile: "Whalebuddy Ads",
      tabGroup: "Ppan"
    };
    delete telemetry[missing];
    assert.throws(
      () => validateConfig(dynamicInput({
        shopBinding: { mode: "observe-and-pin" },
        telemetry
      })),
      new RegExp(missing)
    );
  }
});

test("dynamic config validates exact time and calendar date formats", () => {
  for (const start of ["6:00", "06:0", "24:00", "06:60", " 06:00"]) {
    assert.throws(
      () => validateConfig(dynamicInput({ liveWindow: { start, end: "23:00" } })),
      /exact HH:MM format/
    );
  }

  for (const effectiveFrom of ["2026-7-19", "2026-02-30", "2026-13-01", " 2026-07-19"]) {
    assert.throws(
      () => validateConfig(dynamicInput({ budgetPolicy: {
        ...validDynamicClient().budgetPolicy,
        effectiveFrom
      } })),
      /YYYY-MM-DD/
    );
  }
});

test("dynamic config rejects non-positive and invalid policy ranges", () => {
  assert.throws(
    () => validateConfig(dynamicInput({ warningThreshold: 0 })),
    /warningThreshold/
  );
  assert.throws(
    () => validateConfig(dynamicInput({ warningThreshold: 1 })),
    /warningThreshold/
  );
  assert.throws(
    () => validateConfig(dynamicInput({ budgetIncrease: { presetPercent: 0, allowManualTarget: true } })),
    /presetPercent/
  );
  assert.throws(
    () => validateConfig(dynamicInput({ budgetIncrease: { presetPercent: 20, allowManualTarget: "yes" } })),
    /allowManualTarget must be a boolean/
  );
  assert.throws(
    () => validateConfig(dynamicInput({ budgetPolicy: {
      ...validDynamicClient().budgetPolicy,
      maxDailyBudget: 0
    } })),
    /maxDailyBudget/
  );
  assert.throws(
    () => validateConfig(dynamicInput({ budgetPolicy: {
      ...validDynamicClient().budgetPolicy,
      revision: 0
    } })),
    /revision must be a positive integer/
  );
});

test("dynamic config requires its monitoring and budget controls", () => {
  for (const key of ["liveWindow", "budgetIncrease", "budgetPolicy"]) {
    const client = validDynamicClient();
    delete client[key];
    assert.throws(() => validateConfig({ clients: [client] }), new RegExp(`${key} is required`));
  }
});

test("LINE approvers may start empty only while pairing is enabled", () => {
  const pairedLater = validateConfig(dynamicInput({
    lineApproverUserIds: [],
    linePairingEnabled: true
  })).clients[0];
  assert.deepEqual(pairedLater.lineApproverUserIds, []);
  assert.equal(pairedLater.linePairingEnabled, true);

  assert.throws(
    () => validateConfig(dynamicInput({ lineApproverUserIds: [], linePairingEnabled: false })),
    /unless linePairingEnabled is true/
  );
  assert.throws(
    () => validateConfig(dynamicInput({ linePairingEnabled: "true" })),
    /linePairingEnabled must be a boolean/
  );
});

test("config index keeps static campaign IDs separate from dynamic clients", () => {
  const input = validInput();
  input.clients.push(validDynamicClient());
  const config = validateConfig(input);
  const index = buildConfigIndex(config);

  assert.equal(index.campaigns.size, 1);
  assert.equal(index.campaigns.get("adv:cmp").campaign.id, "cmp");
  assert.equal(index.dynamicClients.size, 1);
  assert.equal(index.dynamicClients.get("dynamic-client").advertiserId, "dynamic-adv");
  assert.equal([...index.campaigns.keys()].some((key) => key.includes("dynamic-adv")), false);
});

test("dynamic advertiser mappings must be unambiguous", () => {
  const duplicate = validDynamicClient({
    id: "dynamic-client-2",
    storeId: "dynamic-shop-2",
    storeAuthorizedBcId: "dynamic-bc-2"
  });
  assert.throws(
    () => validateConfig({ clients: [validDynamicClient(), duplicate] }),
    /duplicate dynamic advertiser mapping/
  );
});
