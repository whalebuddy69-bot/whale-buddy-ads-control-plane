import fs from "node:fs";
import path from "node:path";

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}`);
  }
  return value;
}

function positiveNumber(value, label, { max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be a positive number no greater than ${max}`);
  }
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function exactTime(value, label) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${label} must use exact HH:MM format`);
  }
  return value;
}

function exactDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use exact YYYY-MM-DD format`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new Error(`${label} must be a valid calendar date in YYYY-MM-DD format`);
  }
  return value;
}

function normalizeLiveWindow(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return {
    start: exactTime(value.start, `${label}.start`),
    end: exactTime(value.end, `${label}.end`)
  };
}

function normalizeBudgetIncrease(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return {
    presetPercent: positiveNumber(value.presetPercent, `${label}.presetPercent`, { max: 1000 }),
    allowManualTarget: booleanValue(value.allowManualTarget, `${label}.allowManualTarget`)
  };
}

function normalizeBudgetPolicy(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (!Number.isInteger(value.revision) || value.revision <= 0) {
    throw new Error(`${label}.revision must be a positive integer`);
  }
  return {
    maxDailyBudget: positiveNumber(value.maxDailyBudget, `${label}.maxDailyBudget`),
    effectiveFrom: exactDate(value.effectiveFrom, `${label}.effectiveFrom`),
    revision: value.revision
  };
}

function normalizeCampaignSelector(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (value.kind !== "active-live-gmv-max") {
    throw new Error(`${label}.kind must be active-live-gmv-max`);
  }
  const currency = requiredString(value.currency, `${label}.currency`).toUpperCase();
  if (currency !== "THB") throw new Error(`${label}.currency must be THB in this pilot release`);
  if (value.requireExactlyOne !== true) {
    throw new Error(`${label}.requireExactlyOne must be true`);
  }
  return {
    kind: value.kind,
    currency,
    expectedTikTokAccountId: requiredString(
      value.expectedTikTokAccountId,
      `${label}.expectedTikTokAccountId`
    ),
    requireExactlyOne: true
  };
}

function normalizeShopBinding(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (value.mode !== "observe-and-pin") {
    throw new Error(`${label}.mode must be observe-and-pin`);
  }
  return { mode: "observe-and-pin" };
}

function normalizeTelemetry(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (value.source !== "chrome-ui") {
    throw new Error(`${label}.source must be chrome-ui`);
  }
  const schemaVersion = value.schemaVersion ?? 1;
  if (![1, 2].includes(schemaVersion)) {
    throw new Error(`${label}.schemaVersion must be 1 or 2`);
  }
  const maxSnapshotAgeSeconds = value.maxSnapshotAgeSeconds ?? 900;
  if (
    !Number.isInteger(maxSnapshotAgeSeconds) ||
    maxSnapshotAgeSeconds < 60 ||
    maxSnapshotAgeSeconds > 3600
  ) {
    throw new Error(`${label}.maxSnapshotAgeSeconds must be an integer between 60 and 3600`);
  }
  const sellerMode = requiredString(value.sellerMode ?? "withoutShop", `${label}.sellerMode`);
  if (sellerMode !== "withoutShop") {
    throw new Error(`${label}.sellerMode must be withoutShop for the storeless pilot`);
  }
  const pageType = requiredString(value.pageType ?? "live", `${label}.pageType`);
  if (pageType !== "live") {
    throw new Error(`${label}.pageType must be live`);
  }
  return {
    source: "chrome-ui",
    browserProfile: requiredString(value.browserProfile, `${label}.browserProfile`),
    tabGroup: requiredString(value.tabGroup, `${label}.tabGroup`),
    businessCenterId: requiredString(value.businessCenterId, `${label}.businessCenterId`),
    sellerMode,
    pageType,
    schemaVersion,
    maxSnapshotAgeSeconds
  };
}

function normalizeLineControl(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (!Array.isArray(value.aliases) || value.aliases.length === 0) {
    throw new Error(`${label}.aliases must contain at least one alias`);
  }
  const aliases = [...new Set(value.aliases.map((item) =>
    requiredString(item, `${label}.aliases`)
  ))];
  if (aliases.some((item) => item.length > 80 || /\s/u.test(item))) {
    throw new Error(`${label}.aliases must be single tokens no longer than 80 characters`);
  }
  const minDailyBudget = positiveNumber(
    value.minDailyBudget ?? 100,
    `${label}.minDailyBudget`
  );
  const minTargetRoi = positiveNumber(
    value.minTargetRoi ?? 0.1,
    `${label}.minTargetRoi`,
    { max: 1000 }
  );
  const maxTargetRoi = positiveNumber(
    value.maxTargetRoi ?? 100,
    `${label}.maxTargetRoi`,
    { max: 1000 }
  );
  if (maxTargetRoi <= minTargetRoi) {
    throw new Error(`${label}.maxTargetRoi must be greater than minTargetRoi`);
  }
  const minTopUpThresholdPercent = finiteNumber(
    value.minTopUpThresholdPercent ?? 10,
    `${label}.minTopUpThresholdPercent`,
    { min: 1, max: 98 }
  );
  const maxTopUpThresholdPercent = finiteNumber(
    value.maxTopUpThresholdPercent ?? 95,
    `${label}.maxTopUpThresholdPercent`,
    { min: 2, max: 99 }
  );
  if (maxTopUpThresholdPercent <= minTopUpThresholdPercent) {
    throw new Error(`${label}.maxTopUpThresholdPercent must be greater than minTopUpThresholdPercent`);
  }
  let autoBoost;
  if (value.autoBoost != null) {
    if (typeof value.autoBoost !== "object" || Array.isArray(value.autoBoost)) {
      throw new Error(`${label}.autoBoost must be an object`);
    }
    const boostPercent = finiteNumber(
      value.autoBoost.boostPercent ?? 10,
      `${label}.autoBoost.boostPercent`,
      { min: 1, max: 100 }
    );
    const leadMinutes = finiteNumber(
      value.autoBoost.leadMinutes ?? 10,
      `${label}.autoBoost.leadMinutes`,
      { min: 1, max: 180 }
    );
    const maxWindows = finiteNumber(
      value.autoBoost.maxWindows ?? 24,
      `${label}.autoBoost.maxWindows`,
      { min: 1, max: 24 }
    );
    if (![boostPercent, leadMinutes, maxWindows].every(Number.isInteger)) {
      throw new Error(`${label}.autoBoost values must be integers`);
    }
    autoBoost = {
      enabled: booleanValue(value.autoBoost.enabled ?? true, `${label}.autoBoost.enabled`),
      boostPercent,
      leadMinutes,
      maxWindows
    };
  }
  return {
    enabled: booleanValue(value.enabled ?? true, `${label}.enabled`),
    aliases,
    minDailyBudget,
    minTargetRoi,
    maxTargetRoi,
    minTopUpThresholdPercent,
    maxTopUpThresholdPercent,
    minReportIntervalHours: finiteNumber(
      value.minReportIntervalHours ?? 1,
      `${label}.minReportIntervalHours`,
      { min: 1, max: 24 }
    ),
    maxReportIntervalHours: finiteNumber(
      value.maxReportIntervalHours ?? 24,
      `${label}.maxReportIntervalHours`,
      { min: 1, max: 24 }
    ),
    minCouponLeadMinutes: finiteNumber(
      value.minCouponLeadMinutes ?? 5,
      `${label}.minCouponLeadMinutes`,
      { min: 5, max: 180 }
    ),
    maxCouponLeadMinutes: finiteNumber(
      value.maxCouponLeadMinutes ?? 180,
      `${label}.maxCouponLeadMinutes`,
      { min: 5, max: 180 }
    ),
    ...(autoBoost ? { autoBoost } : {})
  };
}

export function validateConfig(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.clients)) {
    throw new Error("config.clients must be an array");
  }

  const config = {
    agencyId: requiredString(input.agencyId ?? "agency", "agencyId"),
    pollIntervalSeconds: finiteNumber(input.pollIntervalSeconds ?? 300, "pollIntervalSeconds", { min: 60 }),
    requestTtlMinutes: finiteNumber(input.requestTtlMinutes ?? 15, "requestTtlMinutes", { min: 2, max: 1440 }),
    warningThreshold: finiteNumber(input.warningThreshold ?? 0.7, "warningThreshold", { min: 0.1, max: 0.99 }),
    cooldownMinutes: finiteNumber(input.cooldownMinutes ?? 30, "cooldownMinutes", { min: 1, max: 1440 }),
    reconciliationWindowMinutes: finiteNumber(
      input.reconciliationWindowMinutes ?? 15,
      "reconciliationWindowMinutes",
      { min: 5, max: 120 }
    ),
    clients: []
  };

  const clientIds = new Set();
  const campaignKeys = new Set();
  const dynamicAdvertiserIds = new Set();
  const lineControlAliases = new Map();

  for (const rawClient of input.clients) {
    const id = requiredString(rawClient.id, "client.id");
    if (clientIds.has(id)) throw new Error(`duplicate client.id: ${id}`);
    clientIds.add(id);

    const linePairingEnabled = booleanValue(rawClient.linePairingEnabled ?? false, `${id}.linePairingEnabled`);
    if (!Array.isArray(rawClient.lineApproverUserIds)) {
      throw new Error(`${id}.lineApproverUserIds must be an array`);
    }
    if (rawClient.lineApproverUserIds.length === 0 && !linePairingEnabled) {
      throw new Error(`${id}.lineApproverUserIds must contain at least one LINE user ID unless linePairingEnabled is true`);
    }
    const lineApproverUserIds = [...new Set(rawClient.lineApproverUserIds.map((v) => requiredString(v, `${id}.lineApproverUserIds`)))];
    const advertiserId = requiredString(rawClient.advertiserId, `${id}.advertiserId`);
    const hasShopBinding = Object.hasOwn(rawClient, "shopBinding");
    const hasTelemetry = Object.hasOwn(rawClient, "telemetry");
    if (hasShopBinding !== hasTelemetry) {
      throw new Error(`${id}.shopBinding and ${id}.telemetry must be configured together`);
    }
    const shopBinding = hasShopBinding
      ? normalizeShopBinding(rawClient.shopBinding, `${id}.shopBinding`)
      : undefined;
    const telemetry = hasTelemetry
      ? normalizeTelemetry(rawClient.telemetry, `${id}.telemetry`)
      : undefined;
    const observeAndPin = shopBinding?.mode === "observe-and-pin" && telemetry?.source === "chrome-ui";
    const hasStoreId = Object.hasOwn(rawClient, "storeId");
    const hasStoreAuthorizedBcId = Object.hasOwn(rawClient, "storeAuthorizedBcId");
    if (hasStoreId !== hasStoreAuthorizedBcId) {
      throw new Error(`${id}.storeId and ${id}.storeAuthorizedBcId must both be present or both be absent`);
    }
    if (!hasStoreId && !observeAndPin) {
      throw new Error(
        `${id}.storeId and ${id}.storeAuthorizedBcId may be absent only when shopBinding.mode is observe-and-pin and telemetry.source is chrome-ui`
      );
    }
    const storeId = hasStoreId ? requiredString(rawClient.storeId, `${id}.storeId`) : undefined;
    const storeAuthorizedBcId = hasStoreAuthorizedBcId
      ? requiredString(rawClient.storeAuthorizedBcId, `${id}.storeAuthorizedBcId`)
      : undefined;
    const campaigns = [];
    const hasCampaigns = Object.hasOwn(rawClient, "campaigns");
    const hasCampaignSelector = Object.hasOwn(rawClient, "campaignSelector");

    if (hasCampaigns && hasCampaignSelector) {
      throw new Error(`${id}.campaigns and ${id}.campaignSelector are mutually exclusive`);
    }
    if (!hasCampaigns && !hasCampaignSelector) {
      throw new Error(`${id} must configure exactly one of campaigns or campaignSelector`);
    }

    if (hasCampaigns && (!Array.isArray(rawClient.campaigns) || rawClient.campaigns.length === 0)) {
      throw new Error(`${id}.campaigns must contain at least one campaign`);
    }

    for (const rawCampaign of rawClient.campaigns ?? []) {
      const campaignId = requiredString(rawCampaign.id, `${id}.campaign.id`);
      const key = `${advertiserId}:${campaignId}`;
      if (campaignKeys.has(key)) throw new Error(`duplicate advertiser/campaign mapping: ${key}`);
      campaignKeys.add(key);

      const currency = requiredString(rawCampaign.currency, `${id}.${campaignId}.currency`).toUpperCase();
      if (currency !== "THB") throw new Error(`${id}.${campaignId}.currency must be THB in this pilot release`);
      campaigns.push({
        id: campaignId,
        name: requiredString(rawCampaign.name, `${id}.${campaignId}.name`),
        currency,
        maxDailyBudget: finiteNumber(rawCampaign.maxDailyBudget, `${id}.${campaignId}.maxDailyBudget`, { min: 1 }),
        maxIncreasePercent: finiteNumber(rawCampaign.maxIncreasePercent ?? 100, `${id}.${campaignId}.maxIncreasePercent`, { min: 1, max: 1000 }),
        suggestionMultiplier: finiteNumber(rawCampaign.suggestionMultiplier ?? 1.5, `${id}.${campaignId}.suggestionMultiplier`, { min: 1.01, max: 10 }),
        minIncrease: finiteNumber(rawCampaign.minIncrease ?? 0, `${id}.${campaignId}.minIncrease`, { min: 0 })
      });
    }

    const campaignSelector = hasCampaignSelector
      ? normalizeCampaignSelector(rawClient.campaignSelector, `${id}.campaignSelector`)
      : undefined;
    if (campaignSelector) {
      if (dynamicAdvertiserIds.has(advertiserId)) {
        throw new Error(`duplicate dynamic advertiser mapping: ${advertiserId}`);
      }
      dynamicAdvertiserIds.add(advertiserId);
    }

    const warningThreshold = finiteNumber(
      rawClient.warningThreshold ?? config.warningThreshold,
      `${id}.warningThreshold`,
      { min: Number.EPSILON, max: 0.99 }
    );
    const liveWindow = rawClient.liveWindow == null
      ? undefined
      : normalizeLiveWindow(rawClient.liveWindow, `${id}.liveWindow`);
    const budgetIncrease = rawClient.budgetIncrease == null
      ? undefined
      : normalizeBudgetIncrease(rawClient.budgetIncrease, `${id}.budgetIncrease`);
    const budgetPolicy = rawClient.budgetPolicy == null
      ? undefined
      : normalizeBudgetPolicy(rawClient.budgetPolicy, `${id}.budgetPolicy`);
    const lineControl = rawClient.lineControl == null
      ? undefined
      : normalizeLineControl(rawClient.lineControl, `${id}.lineControl`);

    if (campaignSelector && !liveWindow) throw new Error(`${id}.liveWindow is required for a dynamic campaign selector`);
    if (campaignSelector && !budgetIncrease) throw new Error(`${id}.budgetIncrease is required for a dynamic campaign selector`);
    if (campaignSelector && !budgetPolicy) throw new Error(`${id}.budgetPolicy is required for a dynamic campaign selector`);

    const client = {
      id,
      name: requiredString(rawClient.name, `${id}.name`),
      lineApproverUserIds,
      linePairingEnabled,
      advertiserId,
      timezone: requiredString(rawClient.timezone ?? "Asia/Bangkok", `${id}.timezone`),
      warningThreshold
    };
    if (storeId !== undefined) client.storeId = storeId;
    if (storeAuthorizedBcId !== undefined) client.storeAuthorizedBcId = storeAuthorizedBcId;
    if (shopBinding) client.shopBinding = shopBinding;
    if (telemetry) client.telemetry = telemetry;
    if (hasCampaigns) client.campaigns = campaigns;
    if (campaignSelector) client.campaignSelector = campaignSelector;
    if (liveWindow) client.liveWindow = liveWindow;
    if (budgetIncrease) client.budgetIncrease = budgetIncrease;
    if (budgetPolicy) client.budgetPolicy = budgetPolicy;
    if (lineControl) {
      if (!budgetPolicy) throw new Error(`${id}.budgetPolicy is required when lineControl is configured`);
      if (lineControl.minDailyBudget > budgetPolicy.maxDailyBudget) {
        throw new Error(`${id}.lineControl.minDailyBudget cannot exceed budgetPolicy.maxDailyBudget`);
      }
      if (lineControl.maxReportIntervalHours < lineControl.minReportIntervalHours) {
        throw new Error(`${id}.lineControl.maxReportIntervalHours must be at least minReportIntervalHours`);
      }
      if (lineControl.maxCouponLeadMinutes < lineControl.minCouponLeadMinutes) {
        throw new Error(`${id}.lineControl.maxCouponLeadMinutes must be at least minCouponLeadMinutes`);
      }
      if (lineControl.enabled) {
        if (telemetry?.source !== "chrome-ui") {
          throw new Error(`${id}.telemetry.source must be chrome-ui when lineControl.enabled is true`);
        }
        if (!campaignSelector) {
          throw new Error(`${id}.campaignSelector is required when lineControl.enabled is true`);
        }
        if (!liveWindow) {
          throw new Error(`${id}.liveWindow is required when lineControl.enabled is true`);
        }
        const names = [id, rawClient.name, ...lineControl.aliases]
          .map((value) => requiredString(value, `${id}.lineControl.aliases`));
        for (const alias of names) {
          const key = alias.toLocaleLowerCase("th-TH");
          const owner = lineControlAliases.get(key);
          if (owner && owner !== id) {
            throw new Error(`duplicate lineControl alias: ${alias}`);
          }
          lineControlAliases.set(key, id);
        }
      }
      client.lineControl = lineControl;
    }
    config.clients.push(client);
  }

  return config;
}

export function loadConfig(configPath = process.env.CONFIG_PATH ?? "./config/clients.json") {
  const absolutePath = path.resolve(configPath);
  const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  return validateConfig(parsed);
}

export function buildConfigIndex(config) {
  const campaigns = new Map();
  const dynamicClients = new Map();
  const approverClients = new Map();

  for (const client of config.clients) {
    for (const campaign of client.campaigns ?? []) {
      campaigns.set(`${client.advertiserId}:${campaign.id}`, { client, campaign });
    }
    if (client.campaignSelector) dynamicClients.set(client.id, client);
    for (const userId of client.lineApproverUserIds) {
      const allowed = approverClients.get(userId) ?? new Set();
      allowed.add(client.id);
      approverClients.set(userId, allowed);
    }
  }

  return { campaigns, dynamicClients, approverClients };
}

export function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
