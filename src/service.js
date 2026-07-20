import crypto from "node:crypto";
import { DomainError, RequestState, createBudgetRequest, isTerminalState } from "./domain.js";
import {
  buildBudgetAlertMessage,
  buildObservedBudgetChangeMessage,
  buildBudgetConfirmationMessage,
  buildResultMessage,
  parseBudgetText,
  parsePairingText,
  parsePostbackData,
  requestCodeFor
} from "./line.js";
import { fromMinor, toMinor } from "./money.js";
import {
  TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
  telemetryUiCampaignRef
} from "./telemetry.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeError(error) {
  return {
    code: error?.code ? String(error.code) : "EXECUTION_ERROR",
    message: error?.message || "Unknown error",
    outcomeKnown: error?.outcomeKnown !== false,
    requestId: error?.requestId == null ? null : String(error.requestId)
  };
}

function webhookEventId(event) {
  if (event.webhookEventId) return event.webhookEventId;
  const stableEvent = {
    type: event.type,
    timestamp: event.timestamp ?? null,
    source: event.source ?? null,
    message: event.message == null
      ? null
      : { id: event.message.id ?? null, type: event.message.type ?? null, text: event.message.text ?? null },
    postback: event.postback == null ? null : { data: event.postback.data ?? null }
  };
  return `legacy-${crypto.createHash("sha256").update(JSON.stringify(stableEvent)).digest("hex").slice(0, 32)}`;
}

function stableRetryKey(...parts) {
  const hex = crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function pairingCodeHash(clientId, code) {
  return crypto.createHash("sha256").update(`${clientId}\u0000${code}`).digest("hex");
}

function allowsManualTarget(request) {
  if (request?.metadata?.allowManualTarget !== undefined) {
    return request.metadata.allowManualTarget !== false;
  }
  // Older dynamic request snapshots already carry this authority inside the
  // policy object. Static requests predate the flag and retain manual input.
  return request?.metadata?.dynamicPolicy?.allowManualTarget !== false;
}

function normalizedLineCommand(event) {
  const userId = event.source?.userId;
  if (!userId) return null;
  if (event.type === "postback" && parsePostbackData(event.postback?.data)) {
    return { kind: "postback", userId, data: event.postback.data };
  }
  if (event.type === "message" && event.message?.type === "text") {
    const pairing = parsePairingText(event.message.text);
    if (pairing) {
      return {
        kind: "pairing",
        userId,
        clientId: pairing.clientId,
        codeHash: pairingCodeHash(pairing.clientId, pairing.code),
        sourceType: event.source?.type ?? null
      };
    }
    if (parseBudgetText(event.message.text)) {
      return { kind: "budget_text", userId, text: event.message.text };
    }
  }
  return null;
}

function calculateSuggestedTarget(currentBudget, campaign) {
  if (campaign.dynamicPolicy) {
    return Math.min(
      campaign.maxDailyBudget,
      currentBudget * (1 + campaign.dynamicPolicy.presetPercent / 100)
    );
  }
  return Math.min(
    campaign.maxDailyBudget,
    Math.max(currentBudget * campaign.suggestionMultiplier, currentBudget + campaign.minIncrease)
  );
}

function zonedDateTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function localDateFor(date, timeZone) {
  const parts = zonedDateTimeParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function timeMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function isWithinLiveWindow(date, timeZone, liveWindow) {
  const parts = zonedDateTimeParts(date, timeZone);
  const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const start = timeMinutes(liveWindow.start);
  const end = timeMinutes(liveWindow.end);
  if (start === end) return false;
  return start < end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end;
}

function dynamicAccountIds(info) {
  const values = [];
  const add = (value) => {
    if (value == null || value === "") return;
    if (Array.isArray(value)) return value.forEach(add);
    if (typeof value === "object") {
      add(value.tiktok_account_id);
      add(value.tiktokAccountId);
      add(value.identity_id);
      return;
    }
    values.push(String(value));
  };
  add(info?.tiktokAccountId);
  add(info?.tiktokAccountIds);
  add(info?.raw?.tiktok_account_id);
  add(info?.raw?.tiktok_account_ids);
  add(info?.raw?.tiktok_accounts);
  add(info?.raw?.identity_id);
  add(info?.raw?.identity_ids);
  add(info?.raw?.identities);
  return [...new Set(values)];
}

function dynamicAuthoritySnapshot(client, policyLocalDate) {
  return {
    authoritySchemaVersion: 1,
    presetPercent: client.budgetIncrease.presetPercent,
    allowManualTarget: client.budgetIncrease.allowManualTarget,
    revision: client.budgetPolicy.revision,
    effectiveFrom: client.budgetPolicy.effectiveFrom,
    maxDailyBudget: client.budgetPolicy.maxDailyBudget,
    policyLocalDate,
    expectedTikTokAccountId: client.campaignSelector.expectedTikTokAccountId,
    liveWindow: {
      start: client.liveWindow.start,
      end: client.liveWindow.end
    },
    timezone: client.timezone,
    selectorKind: client.campaignSelector.kind,
    currency: client.campaignSelector.currency,
    requireExactlyOne: client.campaignSelector.requireExactlyOne
  };
}

// Serialize every field that grants dynamic execution authority in a fixed
// order. Comparing this canonical form avoids relying on operators remembering
// to bump revision whenever any individual guardrail changes.
function canonicalDynamicAuthority(policy) {
  return JSON.stringify({
    authoritySchemaVersion: policy?.authoritySchemaVersion ?? null,
    presetPercent: policy?.presetPercent ?? null,
    allowManualTarget: policy?.allowManualTarget ?? null,
    revision: policy?.revision ?? null,
    effectiveFrom: policy?.effectiveFrom ?? null,
    maxDailyBudget: policy?.maxDailyBudget ?? null,
    policyLocalDate: policy?.policyLocalDate ?? null,
    expectedTikTokAccountId: policy?.expectedTikTokAccountId ?? null,
    liveWindow: policy?.liveWindow == null
      ? null
      : {
          start: policy.liveWindow.start ?? null,
          end: policy.liveWindow.end ?? null
        },
    timezone: policy?.timezone ?? null,
    selectorKind: policy?.selectorKind ?? null,
    currency: policy?.currency ?? null,
    requireExactlyOne: policy?.requireExactlyOne ?? null
  });
}

function dynamicAuthorityDigest(canonical) {
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function telemetryOnlyRequest(request) {
  return request?.metadata?.telemetryOnly === true
    || request?.metadata?.executionMode === "APPROVAL_ONLY"
    || request?.metadata?.source === "CHROME_TELEMETRY_DRY_RUN";
}

function thresholdReached(costMinor, budgetMinor, threshold) {
  const scale = 1_000_000;
  const scaledThreshold = Math.round(threshold * scale);
  return BigInt(costMinor) * BigInt(scale) >= BigInt(budgetMinor) * BigInt(scaledThreshold);
}

export class BudgetGuardService {
  constructor({
    config,
    store,
    tiktok,
    line,
    executionEnabled = false,
    telemetryAlertsEnabled = false,
    logger = console,
    now = () => new Date()
  }) {
    this.config = config;
    this.store = store;
    this.tiktok = tiktok;
    this.line = line;
    this.executionEnabled = executionEnabled;
    this.telemetryAlertsEnabled = telemetryAlertsEnabled;
    this.logger = logger;
    this.now = now;
  }

  #clientById(clientId) {
    return this.config.clients.find((client) => client.id === clientId) ?? null;
  }

  #approversForClient(client) {
    const configured = client.lineApproverUserIds ?? [];
    const paired = typeof this.store.listLineApprovers === "function"
      ? this.store.listLineApprovers({ clientId: client.id }).map((item) => item.lineUserId)
      : [];
    return [...new Set([...configured, ...paired])].sort();
  }

  #isCurrentApprover(client, userId) {
    return this.#approversForClient(client).includes(userId);
  }

  createLinePairing({ clientId, ttlMinutes = 10 } = {}) {
    const client = this.#clientById(clientId);
    if (!client) throw new DomainError("CLIENT_NOT_FOUND", "Client is not present in the approved config");
    if (client.linePairingEnabled !== true) {
      throw new DomainError("LINE_PAIRING_DISABLED", "LINE pairing is not enabled for this client");
    }
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 2 || ttlMinutes > 60) {
      throw new DomainError("INVALID_REQUEST", "ttlMinutes must be an integer between 2 and 60");
    }
    const code = crypto.randomBytes(18).toString("base64url");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60_000);
    const pairing = this.store.createLinePairing({
      clientId: client.id,
      codeHash: pairingCodeHash(client.id, code),
      createdAt,
      expiresAt
    });
    return Object.freeze({
      clientId: client.id,
      code,
      command: `จับคู่ ${client.id} ${code}`,
      expiresAt: pairing.expiresAt
    });
  }

  #view(request) {
    const suggestedMinor = request.targetBudgetMinor ?? request.metadata.suggestedTargetMinor;
    return {
      id: request.id,
      version: request.version,
      shortCode: requestCodeFor(request.id),
      clientName: request.metadata.clientName,
      campaignName: request.metadata.campaignName,
      advertiserId: request.adAccountId,
      currency: request.currency,
      timezone: request.metadata.timezone,
      currentBudget: fromMinor(request.currentBudgetMinor, request.currency),
      proposedBudget: fromMinor(suggestedMinor, request.currency),
      maxBudget: fromMinor(request.guardrails.maxBudgetMinor, request.currency),
      presetLabel: request.metadata.presetLabel ?? "ใช้งบแนะนำ",
      allowManualTarget: allowsManualTarget(request),
      telemetryOnly: request.metadata.telemetryOnly === true,
      dryRun: request.metadata.dryRun === true,
      spend: request.metadata.spendMinor == null ? null : fromMinor(request.metadata.spendMinor, request.currency),
      expiresAt: request.expiresAt
    };
  }

  #findMapping(adAccountId, campaignId) {
    for (const client of this.config.clients) {
      if (String(client.advertiserId) !== String(adAccountId)) continue;
      const campaign = (client.campaigns ?? []).find((item) => String(item.id) === String(campaignId));
      if (campaign) return { client, campaign };
    }
    return null;
  }

  #dynamicCampaign(client, info, policyLocalDate) {
    return {
      id: String(info.campaignId),
      name: info.campaignName || `${policyLocalDate} ${client.liveWindow.start}:00`,
      currency: client.campaignSelector.currency,
      maxDailyBudget: client.budgetPolicy.maxDailyBudget,
      dynamicPolicy: dynamicAuthoritySnapshot(client, policyLocalDate)
    };
  }

  #assertDynamicPolicyAvailable(client, at = this.now()) {
    const policyLocalDate = localDateFor(at, client.timezone);
    if (policyLocalDate < client.budgetPolicy.effectiveFrom) {
      throw new DomainError("NO_EFFECTIVE_BUDGET_POLICY", "The approved budget policy is not effective yet", {
        policyLocalDate,
        effectiveFrom: client.budgetPolicy.effectiveFrom
      });
    }
    if (!isWithinLiveWindow(at, client.timezone, client.liveWindow)) {
      throw new DomainError("OUTSIDE_LIVE_WINDOW", "The client is outside its approved LIVE monitoring window", {
        policyLocalDate,
        liveWindow: client.liveWindow
      });
    }
    return policyLocalDate;
  }

  async #resolveDynamicCampaign(client, { requireEnabled = true } = {}) {
    const policyLocalDate = this.#assertDynamicPolicyAvailable(client);
    const expectedName = `${policyLocalDate} ${client.liveWindow.start}:00`;
    const listed = await this.tiktok.getLiveCampaigns({
      advertiserId: client.advertiserId,
      storeId: client.storeId
    });
    const namedCandidates = listed.filter((item) => String(item?.campaign_name ?? "") === expectedName);
    const resolved = [];
    for (const candidate of namedCandidates) {
      if (typeof candidate?.campaign_id !== "string" || candidate.campaign_id === "") {
        throw new DomainError("TIKTOK_MALFORMED_CAMPAIGN_LIST", "A daily LIVE campaign omitted campaign_id");
      }
      const provisional = {
        id: String(candidate.campaign_id),
        expectedTikTokAccountId: client.campaignSelector.expectedTikTokAccountId
      };
      const info = await this.tiktok.getCampaignInfo({
        advertiserId: client.advertiserId,
        campaignId: provisional.id
      });
      this.#assertCampaignIdentity(info, client, provisional, { requireEnabled: false });
      if (String(info.campaignName ?? "") !== expectedName) {
        throw new DomainError("DYNAMIC_CAMPAIGN_NAME_MISMATCH", "TikTok campaign details do not match the selected daily campaign name");
      }
      if (info.operationStatus === "ENABLE") resolved.push(info);
    }
    if (resolved.length === 0) {
      throw new DomainError("DYNAMIC_CAMPAIGN_NOT_FOUND", "No enabled LIVE GMV Max campaign matched today's approved selector", {
        expectedName
      });
    }
    if (resolved.length !== 1) {
      throw new DomainError("DYNAMIC_CAMPAIGN_AMBIGUOUS", "More than one enabled LIVE GMV Max campaign matched today's approved selector", {
        expectedName,
        count: resolved.length
      });
    }
    const [info] = resolved;
    if (requireEnabled && info.operationStatus !== "ENABLE") {
      throw new DomainError("CAMPAIGN_NOT_ENABLED", "TikTok campaign is not enabled");
    }
    return { client, campaign: this.#dynamicCampaign(client, info, policyLocalDate), info, policyLocalDate };
  }

  #assertCampaignIdentity(info, client, campaign, { requireEnabled = true } = {}) {
    const checks = [
      [String(info?.advertiserId ?? ""), String(client.advertiserId), "ACCOUNT_MISMATCH", "TikTok advertiser does not match the configured client"],
      [String(info?.campaignId ?? ""), String(campaign.id), "CAMPAIGN_MISMATCH", "TikTok campaign does not match the configured campaign"],
      [String(info?.storeId ?? ""), String(client.storeId), "STORE_MISMATCH", "TikTok Shop does not match the configured client"],
      [
        String(info?.storeAuthorizedBcId ?? ""),
        String(client.storeAuthorizedBcId),
        "BUSINESS_CENTER_MISMATCH",
        "TikTok Shop authorization Business Center does not match the configured client"
      ],
      [String(info?.shoppingAdsType ?? ""), "LIVE", "NOT_LIVE_GMV_MAX", "Configured campaign is not LIVE GMV Max"]
    ];
    for (const [actual, expected, code, message] of checks) {
      if (actual !== expected) throw new DomainError(code, message, { expected, actual });
    }
    if (campaign.expectedTikTokAccountId) {
      const accountIds = dynamicAccountIds(info);
      if (accountIds.length === 0) {
        throw new DomainError(
          "TIKTOK_ACCOUNT_ID_UNVERIFIED",
          "TikTok campaign details did not expose the LIVE TikTok account identity"
        );
      }
      if (accountIds.length !== 1) {
        throw new DomainError(
          "TIKTOK_ACCOUNT_ID_AMBIGUOUS",
          "TikTok campaign details exposed more than one distinct LIVE TikTok account identity",
          {
            expected: String(campaign.expectedTikTokAccountId),
            actual: accountIds
          }
        );
      }
      if (accountIds[0] !== String(campaign.expectedTikTokAccountId)) {
        throw new DomainError("TIKTOK_ACCOUNT_MISMATCH", "TikTok LIVE account does not match the configured client", {
          expected: String(campaign.expectedTikTokAccountId),
          actual: accountIds
        });
      }
    }
    if (!Number.isFinite(info?.budget) || info.budget <= 0) {
      throw new DomainError("INVALID_TIKTOK_BUDGET", "TikTok returned an invalid campaign budget");
    }
    if (!new Set(["ENABLE", "DISABLE"]).has(info.operationStatus)) {
      throw new DomainError("INVALID_CAMPAIGN_STATUS", "TikTok returned an unknown campaign status");
    }
    if (requireEnabled && info.operationStatus !== "ENABLE") {
      throw new DomainError("CAMPAIGN_NOT_ENABLED", "TikTok campaign is not enabled");
    }
    return info;
  }

  #assertDynamicAuthorityUnchanged(snapshot, current) {
    const snapshotCanonical = canonicalDynamicAuthority(snapshot);
    const currentCanonical = canonicalDynamicAuthority(current);
    if (snapshotCanonical !== currentCanonical) {
      throw new DomainError(
        "BUDGET_POLICY_CHANGED",
        "The approved dynamic budget authority changed or crossed its local date",
        {
          snapshotDigest: dynamicAuthorityDigest(snapshotCanonical),
          currentDigest: dynamicAuthorityDigest(currentCanonical)
        }
      );
    }
  }

  #requestMapping(request) {
    if (telemetryOnlyRequest(request)) {
      throw new DomainError(
        "TELEMETRY_ONLY_REQUEST",
        "A telemetry dry-run request has no TikTok execution authority"
      );
    }
    const client = this.#clientById(request.clientId);
    if (!client || String(client.advertiserId) !== String(request.adAccountId)) {
      throw new DomainError("CONFIG_MAPPING_REVOKED", "The client/advertiser mapping is no longer approved");
    }
    if (client.campaignSelector) {
      if (request.metadata.dynamicCampaign !== true) {
        throw new DomainError("CONFIG_MAPPING_REVOKED", "The request is missing its dynamic campaign authority snapshot");
      }
      return {
        client,
        campaign: {
          id: String(request.campaignId),
          name: request.metadata.campaignName,
          currency: request.currency,
          maxDailyBudget: fromMinor(request.guardrails.maxBudgetMinor, request.currency),
          expectedTikTokAccountId: client.campaignSelector.expectedTikTokAccountId,
          dynamicPolicy: request.metadata.dynamicPolicy
        },
        dynamic: true
      };
    }
    const campaign = (client.campaigns ?? []).find((item) => String(item.id) === String(request.campaignId));
    if (!campaign) throw new DomainError("CONFIG_MAPPING_REVOKED", "The advertiser/campaign mapping is no longer approved");
    return { client, campaign, dynamic: false };
  }

  #currentExecutionMapping(request, userId) {
    const mapping = this.#requestMapping(request);
    if (!this.#isCurrentApprover(mapping.client, userId)) {
      throw new DomainError("APPROVER_REVOKED", "This LINE user is no longer an approved operator for the client");
    }
    if (
      String(mapping.client.storeId) !== String(request.metadata.storeId) ||
      String(mapping.client.storeAuthorizedBcId) !== String(request.metadata.storeAuthorizedBcId)
    ) {
      throw new DomainError("CONFIG_IDENTITY_CHANGED", "The configured Shop or Business Center changed after approval was requested");
    }
    if (mapping.dynamic) {
      const policyLocalDate = this.#assertDynamicPolicyAvailable(mapping.client);
      this.#assertDynamicAuthorityUnchanged(
        request.metadata.dynamicPolicy,
        dynamicAuthoritySnapshot(mapping.client, policyLocalDate)
      );
    }
    return mapping;
  }

  #createSnapshotRequest({ client, campaign, currentBudget, spend, proposedBudget }) {
    const currentBudgetMinor = toMinor(currentBudget, campaign.currency);
    const maxBudgetMinor = toMinor(campaign.maxDailyBudget, campaign.currency);
    const remainingToCeiling = maxBudgetMinor - currentBudgetMinor;
    let maxIncreaseMinor;
    let suggestedTargetMinor;
    if (campaign.dynamicPolicy) {
      const percentTargetMinor = Math.floor(
        currentBudgetMinor * (100 + campaign.dynamicPolicy.presetPercent) / 100
      );
      suggestedTargetMinor = Math.min(maxBudgetMinor, percentTargetMinor);
      maxIncreaseMinor = campaign.dynamicPolicy.allowManualTarget
        ? remainingToCeiling
        : suggestedTargetMinor - currentBudgetMinor;
    } else {
      // maxIncreasePercent is a hard ceiling. minIncrease affects the suggestion,
      // but must never widen the operator-approved percentage guardrail.
      const configuredDelta = Math.floor(currentBudgetMinor * (campaign.maxIncreasePercent / 100));
      maxIncreaseMinor = Math.min(remainingToCeiling, configuredDelta);
      const minIncreaseMinor = toMinor(campaign.minIncrease, campaign.currency);
      if (minIncreaseMinor > maxIncreaseMinor) {
        throw new DomainError("NO_SAFE_INCREASE", "Configured minimum increase does not fit under the hard percentage ceiling");
      }
      const requestedTargetMinor = toMinor(Math.min(proposedBudget, campaign.maxDailyBudget), campaign.currency);
      suggestedTargetMinor = Math.min(requestedTargetMinor, currentBudgetMinor + maxIncreaseMinor);
    }
    if (maxIncreaseMinor <= 0 || suggestedTargetMinor <= currentBudgetMinor) {
      throw new DomainError("NO_SAFE_INCREASE", "No increase is available within the configured guardrails");
    }

    const createdAt = this.now();
    const authorizedLineUserIds = this.#approversForClient(client);
    if (authorizedLineUserIds.length === 0) {
      throw new DomainError("NO_LINE_APPROVER", "No active LINE approver is paired for this client");
    }
    return createBudgetRequest({
      agencyId: this.config.agencyId ?? "agency",
      clientId: client.id,
      adAccountId: String(client.advertiserId),
      campaignId: String(campaign.id),
      authorizedLineUserIds,
      currency: campaign.currency,
      currentBudgetMinor,
      maxBudgetMinor,
      maxIncreaseMinor,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.config.requestTtlMinutes * 60_000),
      metadata: {
        clientName: client.name,
        campaignName: campaign.name,
        storeId: String(client.storeId),
        storeAuthorizedBcId: client.storeAuthorizedBcId,
        timezone: client.timezone,
        spendMinor: spend == null ? null : toMinor(spend, campaign.currency),
        suggestedTargetMinor,
        presetLabel: campaign.dynamicPolicy ? `เพิ่มงบ ${campaign.dynamicPolicy.presetPercent}%` : "ใช้งบแนะนำ",
        allowManualTarget: campaign.dynamicPolicy?.allowManualTarget ?? true,
        dynamicCampaign: Boolean(campaign.dynamicPolicy),
        dynamicPolicy: campaign.dynamicPolicy ?? null,
        source: "MONITOR"
      }
    });
  }

  async createAndSendRequest({ client, campaign, currentBudget, spend = null, proposedBudget, source = "MONITOR" }) {
    const value = this.#createSnapshotRequest({ client, campaign, currentBudget, spend, proposedBudget });
    const request = this.store.createBudgetRequest({
      ...value,
      metadata: { ...value.metadata, source }
    });
    await this.retryUndeliveredAlert(request);
    return request;
  }

  #deliveredApproverIndexes(request) {
    return new Set(this.store.listAuditEvents({ requestId: request.id, eventType: "LINE_ALERT_SENT", limit: 1000 })
      .map((event) => event.details.approverIndex)
      .filter(Number.isSafeInteger));
  }

  getAlertDeliveryStatus(request) {
    const delivered = this.#deliveredApproverIndexes(request).size;
    const total = request.authorizedLineUserIds.length;
    return {
      delivered,
      total,
      status: delivered === total ? "ALERT_DELIVERED" : delivered === 0 ? "ALERT_PENDING" : "ALERT_PARTIAL"
    };
  }

  async retryUndeliveredAlert(request) {
    if (request.state !== RequestState.PENDING_INPUT) return this.getAlertDeliveryStatus(request);
    const delivered = this.#deliveredApproverIndexes(request);
    const message = buildBudgetAlertMessage(this.#view(request));
    for (let index = 0; index < request.authorizedLineUserIds.length; index += 1) {
      if (delivered.has(index)) continue;
      const userId = request.authorizedLineUserIds[index];
      const retryKey = stableRetryKey("budget-alert", request.id, String(index));
      try {
        await this.line.push(userId, message, retryKey);
        delivered.add(index);
        this.store.appendAuditEvent({
          requestId: request.id,
          eventType: "LINE_ALERT_SENT",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: { approverIndex: index, retryKey }
        });
      } catch (error) {
        this.store.appendAuditEvent({
          requestId: request.id,
          eventType: "LINE_ALERT_FAILED",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: {
            approverIndex: index,
            retryKey,
            error: String(error?.message ?? error).slice(0, 500)
          }
        });
      }
    }
    const result = this.getAlertDeliveryStatus(request);
    if (result.status !== "ALERT_DELIVERED") {
      this.logger.error("LINE budget alert is not fully delivered", { requestId: request.id, ...result });
    }
    return result;
  }

  async retryPendingAlerts({ limit = 100 } = {}) {
    this.expireOldRequests();
    const outcomes = [];
    for (const request of this.store.listBudgetRequests({ state: RequestState.PENDING_INPUT, limit })) {
      const before = this.getAlertDeliveryStatus(request);
      if (before.status === "ALERT_DELIVERED") continue;
      const after = await this.retryUndeliveredAlert(request);
      outcomes.push({ requestId: request.id, before: before.status, after: after.status });
    }
    return outcomes;
  }

  #activeRequestFor(adAccountId, campaignId) {
    const latest = this.store.getLatestBudgetRequest({ adAccountId: String(adAccountId), campaignId: String(campaignId) });
    return latest && [RequestState.PENDING_INPUT, RequestState.PENDING_APPROVAL, RequestState.EXECUTING].includes(latest.state)
      ? latest
      : null;
  }

  #terminalReferenceBudgetMinor(request) {
    return request.state === RequestState.SUCCEEDED && request.result?.actualBudgetMinor != null
      ? request.result.actualBudgetMinor
      : request.currentBudgetMinor;
  }

  #latestTerminalRequest(adAccountId, campaignId) {
    const latest = this.store.getLatestBudgetRequest({
      adAccountId: String(adAccountId),
      campaignId: String(campaignId)
    });
    return latest && isTerminalState(latest.state) ? latest : null;
  }

  #cooldownUntil(adAccountId, campaignId, { observedBudgetMinor = null } = {}) {
    const latest = this.store.getLatestBudgetRequest({ adAccountId: String(adAccountId), campaignId: String(campaignId) });
    if (!latest || [RequestState.PENDING_INPUT, RequestState.PENDING_APPROVAL, RequestState.EXECUTING].includes(latest.state)) return null;
    if (
      observedBudgetMinor !== null
      && Number.isSafeInteger(observedBudgetMinor)
      && observedBudgetMinor !== this.#terminalReferenceBudgetMinor(latest)
    ) {
      return null;
    }
    return new Date(Date.parse(latest.updatedAt) + this.config.cooldownMinutes * 60_000);
  }

  async #notifyObservedBudgetChange({ request, snapshot, client }) {
    const referenceBudgetMinor = this.#terminalReferenceBudgetMinor(request);
    if (snapshot.dailyBudgetMinor === referenceBudgetMinor) return { delivered: 0, total: 0 };
    const sent = new Set(
      this.store.listAuditEvents({
        requestId: request.id,
        eventType: "LINE_BUDGET_CHANGE_SENT",
        limit: 1000
      })
        .filter((event) => event.details.observedBudgetMinor === snapshot.dailyBudgetMinor)
        .map((event) => event.details.approverIndex)
        .filter(Number.isSafeInteger)
    );
    let total = 0;
    for (let index = 0; index < request.authorizedLineUserIds.length; index += 1) {
      const userId = request.authorizedLineUserIds[index];
      if (!this.#isCurrentApprover(client, userId)) continue;
      total += 1;
      if (sent.has(index)) continue;
      const retryKey = stableRetryKey(
        "observed-budget-change",
        request.id,
        String(snapshot.dailyBudgetMinor),
        String(index)
      );
      try {
        await this.line.push(userId, buildObservedBudgetChangeMessage({
          clientName: request.metadata.clientName,
          campaignName: snapshot.campaignName,
          currency: snapshot.currency,
          previousBudget: fromMinor(referenceBudgetMinor, snapshot.currency),
          observedBudget: fromMinor(snapshot.dailyBudgetMinor, snapshot.currency),
          requestId: request.id,
          telemetryOnly: telemetryOnlyRequest(request)
        }), retryKey);
        sent.add(index);
        this.store.appendAuditEvent({
          requestId: request.id,
          eventType: "LINE_BUDGET_CHANGE_SENT",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: {
            snapshotId: snapshot.snapshotId,
            observedBudgetMinor: snapshot.dailyBudgetMinor,
            referenceBudgetMinor,
            approverIndex: index,
            retryKey,
            telemetryOnly: telemetryOnlyRequest(request)
          }
        });
      } catch (error) {
        this.store.appendAuditEvent({
          requestId: request.id,
          eventType: "LINE_BUDGET_CHANGE_FAILED",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: {
            snapshotId: snapshot.snapshotId,
            observedBudgetMinor: snapshot.dailyBudgetMinor,
            referenceBudgetMinor,
            approverIndex: index,
            retryKey,
            error: String(error?.message ?? error).slice(0, 500)
          }
        });
      }
    }
    return { delivered: sent.size, total };
  }

  async processTelemetrySnapshotForDryRunAlert({ snapshot, latest = true } = {}) {
    const skip = (status, details = {}) => ({
      clientId: snapshot?.clientId ?? null,
      snapshotId: snapshot?.snapshotId ?? null,
      status,
      ...details
    });
    if (!this.telemetryAlertsEnabled) return skip("SKIP_TELEMETRY_ALERTS_DISABLED");
    if (latest !== true) return skip("SKIP_NOT_LATEST");
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return skip("SKIP_INVALID_SNAPSHOT");
    }
    if (
      snapshot.schemaVersion !== 1
      || snapshot.uiSchemaFingerprint !== TELEMETRY_UI_SCHEMA_FINGERPRINT_V1
    ) {
      return skip("SKIP_TELEMETRY_SCHEMA_MISMATCH");
    }
    if (
      typeof this.store.isTelemetrySnapshotCredentialActive === "function"
      && this.store.isTelemetrySnapshotCredentialActive(snapshot.snapshotId) === false
    ) {
      return skip("SKIP_REVOKED_TELEMETRY_CREDENTIAL");
    }

    const client = this.#clientById(snapshot.clientId);
    if (!client || client.telemetry?.source !== "chrome-ui" || !client.campaignSelector) {
      return skip("SKIP_CLIENT_BINDING_MISMATCH");
    }
    const exactBindings = [
      [snapshot.advertiserId, client.advertiserId],
      [snapshot.businessCenterId, client.telemetry.businessCenterId],
      [snapshot.sellerMode, client.telemetry.sellerMode],
      [snapshot.pageType, client.telemetry.pageType],
      [snapshot.tiktokAccountId, client.campaignSelector.expectedTikTokAccountId],
      [snapshot.source?.browserProfile, client.telemetry.browserProfile],
      [snapshot.source?.tabGroup, client.telemetry.tabGroup],
      [snapshot.campaignType, "LIVE_GMV_MAX"],
      [snapshot.campaignStatus, "ACTIVE"],
      [snapshot.currency, client.campaignSelector.currency]
    ];
    if (exactBindings.some(([actual, expected]) => actual !== expected)) {
      return skip("SKIP_CLIENT_BINDING_MISMATCH");
    }
    if (snapshot.campaignId !== null) return skip("SKIP_OBSERVED_CAMPAIGN_ID_PRESENT");

    const observedAt = new Date(snapshot.observedAt);
    const now = this.now();
    if (Number.isNaN(observedAt.getTime()) || Number.isNaN(now.getTime())) {
      return skip("SKIP_INVALID_OBSERVATION_TIME");
    }
    const ageMilliseconds = now.getTime() - observedAt.getTime();
    if (
      ageMilliseconds < -60_000
      || ageMilliseconds > client.telemetry.maxSnapshotAgeSeconds * 1000
    ) {
      return skip("SKIP_STALE_SNAPSHOT");
    }

    const policyLocalDate = localDateFor(now, client.timezone);
    const observedLocalDate = localDateFor(observedAt, client.timezone);
    if (policyLocalDate !== observedLocalDate) return skip("SKIP_LOCAL_DATE_MISMATCH");
    if (
      !isWithinLiveWindow(now, client.timezone, client.liveWindow)
      || !isWithinLiveWindow(observedAt, client.timezone, client.liveWindow)
    ) {
      return skip("SKIP_OUTSIDE_LIVE_WINDOW");
    }
    if (policyLocalDate < client.budgetPolicy.effectiveFrom) {
      return skip("SKIP_POLICY_NOT_EFFECTIVE");
    }

    const expectedCampaignName = `${policyLocalDate} ${client.liveWindow.start}:00`;
    if (snapshot.campaignName !== expectedCampaignName) return skip("SKIP_CAMPAIGN_NAME_MISMATCH");
    const expectedCampaignRef = telemetryUiCampaignRef({
      advertiserId: String(client.advertiserId),
      campaignName: expectedCampaignName
    });
    if (snapshot.campaignRef !== expectedCampaignRef) return skip("SKIP_CAMPAIGN_REF_MISMATCH");

    const moneyFields = [
      snapshot.dailyBudgetMinor,
      snapshot.totalBudgetMinor,
      snapshot.costMinor,
      snapshot.netCostMinor
    ];
    if (
      moneyFields.some((value) => !Number.isSafeInteger(value) || value < 0)
      || snapshot.dailyBudgetMinor <= 0
      || snapshot.totalBudgetMinor <= 0
    ) {
      return skip("SKIP_INVALID_MONEY");
    }
    const capMinor = toMinor(client.budgetPolicy.maxDailyBudget, client.campaignSelector.currency);
    if (
      snapshot.policy?.maxDailyBudgetMinor !== capMinor
      || snapshot.policy?.overDailyBudgetCap === true
      || snapshot.dailyBudgetMinor > capMinor
    ) {
      return skip("SKIP_OVER_POLICY_CAP");
    }
    const latestTerminal = this.#latestTerminalRequest(client.advertiserId, snapshot.campaignRef);
    if (
      latestTerminal
      && snapshot.dailyBudgetMinor !== this.#terminalReferenceBudgetMinor(latestTerminal)
    ) {
      await this.#notifyObservedBudgetChange({ request: latestTerminal, snapshot, client });
    }
    if (snapshot.dailyBudgetMinor >= capMinor) return skip("SKIP_NO_SAFE_INCREASE");
    if (!thresholdReached(snapshot.costMinor, snapshot.dailyBudgetMinor, client.warningThreshold)) {
      return skip("BELOW_THRESHOLD", {
        costMinor: snapshot.costMinor,
        dailyBudgetMinor: snapshot.dailyBudgetMinor
      });
    }

    const active = this.#activeRequestFor(client.advertiserId, snapshot.campaignRef);
    if (active) return skip("SKIP_ACTIVE_REQUEST", { requestId: active.id });
    const cooldownUntil = this.#cooldownUntil(client.advertiserId, snapshot.campaignRef, {
      observedBudgetMinor: snapshot.dailyBudgetMinor
    });
    if (cooldownUntil && cooldownUntil.getTime() > now.getTime()) {
      return skip("SKIP_COOLDOWN", { cooldownUntil: cooldownUntil.toISOString() });
    }

    const campaign = {
      // This is a logical observation/dedupe key, never a TikTok campaign ID.
      id: snapshot.campaignRef,
      name: snapshot.campaignName,
      currency: client.campaignSelector.currency,
      maxDailyBudget: client.budgetPolicy.maxDailyBudget,
      dynamicPolicy: dynamicAuthoritySnapshot(client, policyLocalDate)
    };
    const currentBudget = fromMinor(snapshot.dailyBudgetMinor, snapshot.currency);
    const spend = fromMinor(snapshot.costMinor, snapshot.currency);
    const proposedBudget = fromMinor(
      Math.min(
        capMinor,
        Math.floor(snapshot.dailyBudgetMinor * (100 + client.budgetIncrease.presetPercent) / 100)
      ),
      snapshot.currency
    );
    const value = this.#createSnapshotRequest({
      client,
      campaign,
      currentBudget,
      spend,
      proposedBudget
    });
    let request;
    try {
      request = this.store.createBudgetRequest({
        ...value,
        metadata: {
          ...value.metadata,
          source: "CHROME_TELEMETRY_DRY_RUN",
          telemetryOnly: true,
          dryRun: true,
          executionMode: "APPROVAL_ONLY",
          observedCampaignId: null,
          campaignRef: snapshot.campaignRef,
          presetLabel: `ทดสอบเพิ่มงบ ${client.budgetIncrease.presetPercent}%`,
          storeId: null,
          storeAuthorizedBcId: null,
          telemetrySnapshot: {
            snapshotId: snapshot.snapshotId,
            observedAt: snapshot.observedAt,
            advertiserId: snapshot.advertiserId,
            businessCenterId: snapshot.businessCenterId,
            tiktokAccountId: snapshot.tiktokAccountId,
            browserProfile: snapshot.source.browserProfile,
            tabGroup: snapshot.source.tabGroup,
            dailyBudgetMinor: snapshot.dailyBudgetMinor,
            costMinor: snapshot.costMinor
          }
        }
      });
    } catch (error) {
      if (error?.code === "ACTIVE_REQUEST_EXISTS") {
        return skip("SKIP_ACTIVE_REQUEST");
      }
      throw error;
    }
    const delivery = await this.retryUndeliveredAlert(request);
    return skip(delivery.status, {
      requestId: request.id,
      utilization: snapshot.costMinor / snapshot.dailyBudgetMinor
    });
  }

  async processLatestTelemetryDryRunAlerts({ limit = 100 } = {}) {
    if (!this.telemetryAlertsEnabled) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new DomainError("INVALID_REQUEST", "limit must be an integer between 1 and 1000");
    }
    const outcomes = [];
    for (const snapshot of this.store.listLatestTelemetry({ limit })) {
      if (this.store.getTelemetryAlertEvaluation(snapshot.snapshotId)) continue;
      let outcome;
      try {
        outcome = await this.processTelemetrySnapshotForDryRunAlert({ snapshot, latest: true });
      } catch (error) {
        const safe = safeError(error);
        outcome = {
          clientId: snapshot.clientId,
          snapshotId: snapshot.snapshotId,
          status: "ERROR",
          errorCode: safe.code
        };
        this.logger.error("telemetry dry-run alert evaluation failed", {
          clientId: snapshot.clientId,
          snapshotId: snapshot.snapshotId,
          code: safe.code,
          message: safe.message
        });
      }
      this.store.recordTelemetryAlertEvaluation({
        snapshotId: snapshot.snapshotId,
        status: outcome.status,
        requestId: outcome.requestId ?? null,
        evaluatedAt: this.now(),
        details: {
          clientId: outcome.clientId,
          utilization: outcome.utilization ?? null,
          cooldownUntil: outcome.cooldownUntil ?? null,
          errorCode: outcome.errorCode ?? null
        }
      });
      outcomes.push(outcome);
    }
    return outcomes;
  }

  expireOldRequests() {
    const now = this.now();
    for (const state of [RequestState.PENDING_INPUT, RequestState.PENDING_APPROVAL]) {
      for (const request of this.store.listBudgetRequests({ state, limit: 1000 })) {
        if (Date.parse(request.expiresAt) <= now.getTime()) {
          try {
            this.store.expireBudgetRequest(request.id, { now });
          } catch (error) {
            if (error.code !== "CONCURRENT_MODIFICATION" && error.code !== "INVALID_STATE") throw error;
          }
        }
      }
    }
  }

  async validateConfiguredAccess() {
    const verified = [];
    for (const client of this.config.clients) {
      if (client.campaignSelector) {
        const listed = await this.tiktok.getLiveCampaigns({
          advertiserId: client.advertiserId,
          storeId: client.storeId
        });
        verified.push({
          clientId: client.id,
          advertiserId: String(client.advertiserId),
          dynamicCampaignCount: listed.length
        });
        continue;
      }
      for (const campaign of client.campaigns ?? []) {
        const info = await this.tiktok.getCampaignInfo({
          advertiserId: client.advertiserId,
          campaignId: campaign.id
        });
        this.#assertCampaignIdentity(info, client, campaign, { requireEnabled: false });
        verified.push({ clientId: client.id, advertiserId: String(client.advertiserId), campaignId: String(campaign.id) });
      }
    }
    return verified;
  }

  async #pollResolvedCampaign({ client, campaign, resolvedInfo = null }) {
    const activeRequest = this.#activeRequestFor(client.advertiserId, campaign.id);
    if (activeRequest) {
      if (activeRequest.state === RequestState.PENDING_INPUT) {
        const before = this.getAlertDeliveryStatus(activeRequest);
        if (before.status === "ALERT_DELIVERED") {
          return { clientId: client.id, campaignId: campaign.id, status: "SKIP_ACTIVE_REQUEST" };
        }
        const delivery = await this.retryUndeliveredAlert(activeRequest);
        return { clientId: client.id, campaignId: campaign.id, status: delivery.status, requestId: activeRequest.id };
      }
      return { clientId: client.id, campaignId: campaign.id, status: "SKIP_ACTIVE_REQUEST" };
    }
    const info = resolvedInfo ?? await this.tiktok.getCampaignInfo({
      advertiserId: client.advertiserId,
      campaignId: campaign.id
    });
    this.#assertCampaignIdentity(info, client, campaign, { requireEnabled: false });
    if (info.operationStatus !== "ENABLE") {
      return { clientId: client.id, campaignId: campaign.id, status: "SKIP_DISABLED" };
    }
    const cooldownUntil = this.#cooldownUntil(client.advertiserId, campaign.id, {
      observedBudgetMinor: toMinor(info.budget, campaign.currency)
    });
    if (cooldownUntil && cooldownUntil.getTime() > this.now().getTime()) {
      return {
        clientId: client.id,
        campaignId: campaign.id,
        status: "SKIP_COOLDOWN",
        cooldownUntil: cooldownUntil.toISOString()
      };
    }
    const spendResult = await this.tiktok.getTodayCampaignSpend({
      advertiserId: client.advertiserId,
      storeId: client.storeId,
      campaignId: campaign.id,
      timezone: client.timezone,
      now: this.now()
    });
    if (spendResult.currency && spendResult.currency !== campaign.currency) {
      throw new DomainError("REPORT_CURRENCY_MISMATCH", "TikTok report currency does not match the configured campaign currency");
    }
    const utilization = spendResult.spend / info.budget;
    const warningThreshold = client.warningThreshold ?? this.config.warningThreshold;
    if (utilization < warningThreshold) {
      return { clientId: client.id, campaignId: campaign.id, status: "BELOW_THRESHOLD", utilization };
    }
    const proposedBudget = calculateSuggestedTarget(info.budget, campaign);
    const request = await this.createAndSendRequest({
      client,
      campaign,
      currentBudget: info.budget,
      spend: spendResult.spend,
      proposedBudget,
      source: "MONITOR"
    });
    const delivery = this.getAlertDeliveryStatus(request);
    return { clientId: client.id, campaignId: campaign.id, status: delivery.status, requestId: request.id, utilization };
  }

  async pollOnce() {
    this.expireOldRequests();
    const outcomes = [];
    for (const client of this.config.clients) {
      if (client.campaignSelector) {
        try {
          const resolved = await this.#resolveDynamicCampaign(client);
          outcomes.push(await this.#pollResolvedCampaign({
            client,
            campaign: resolved.campaign,
            resolvedInfo: resolved.info
          }));
        } catch (error) {
          const safe = safeError(error);
          // Outside-window and not-yet-effective policies are expected idle
          // states. A missing daily campaign during the approved LIVE window
          // can leave the account unmonitored, so surface and log it as an
          // operator-visible error instead of silently skipping it.
          const skipCodes = new Set(["OUTSIDE_LIVE_WINDOW", "NO_EFFECTIVE_BUDGET_POLICY"]);
          outcomes.push({
            clientId: client.id,
            campaignId: null,
            status: skipCodes.has(safe.code) ? `SKIP_${safe.code}` : "ERROR",
            error: safe
          });
          if (!skipCodes.has(safe.code)) {
            this.logger.error("dynamic monitor error", { clientId: client.id, code: safe.code, message: safe.message });
          }
        }
        continue;
      }
      for (const campaign of client.campaigns ?? []) {
        try {
          outcomes.push(await this.#pollResolvedCampaign({ client, campaign }));
        } catch (error) {
          const safe = safeError(error);
          outcomes.push({ clientId: client.id, campaignId: campaign.id, status: "ERROR", error: safe });
          this.logger.error("monitor error", { clientId: client.id, campaignId: campaign.id, code: safe.code, message: safe.message });
        }
      }
    }
    return outcomes;
  }

  async createManualRequest({ advertiserId, campaignId, proposedBudget }) {
    let mapping = this.#findMapping(advertiserId, campaignId);
    let resolvedInfo = null;
    if (!mapping) {
      const dynamicClient = this.config.clients.find((client) =>
        client.campaignSelector && String(client.advertiserId) === String(advertiserId)
      );
      if (dynamicClient) {
        const resolved = await this.#resolveDynamicCampaign(dynamicClient);
        if (campaignId && String(campaignId) !== String(resolved.campaign.id)) {
          throw new DomainError("DYNAMIC_CAMPAIGN_CHANGED", "The supplied campaign is not today's resolved LIVE campaign");
        }
        mapping = { client: dynamicClient, campaign: resolved.campaign };
        resolvedInfo = resolved.info;
        campaignId = resolved.campaign.id;
      }
    }
    if (!mapping) throw new DomainError("MAPPING_NOT_FOUND", "Advertiser/campaign is not present in the approved config");
    if (this.#activeRequestFor(advertiserId, campaignId)) throw new DomainError("ACTIVE_REQUEST_EXISTS", "An active request already exists for this campaign");
    const info = resolvedInfo ?? await this.tiktok.getCampaignInfo({ advertiserId, campaignId });
    this.#assertCampaignIdentity(info, mapping.client, mapping.campaign);
    const cooldownUntil = this.#cooldownUntil(advertiserId, campaignId, {
      observedBudgetMinor: toMinor(info.budget, mapping.campaign.currency)
    });
    if (cooldownUntil && cooldownUntil.getTime() > this.now().getTime()) {
      throw new DomainError("COOLDOWN_ACTIVE", `Campaign is in cooldown until ${cooldownUntil.toISOString()}`);
    }
    const spendResult = await this.tiktok.getTodayCampaignSpend({
      advertiserId,
      storeId: mapping.client.storeId,
      campaignId,
      timezone: mapping.client.timezone,
      now: this.now()
    });
    return this.createAndSendRequest({
      ...mapping,
      currentBudget: info.budget,
      spend: spendResult.spend,
      proposedBudget,
      source: "ADMIN"
    });
  }

  async #replySafely(replyToken, message, requestId = null) {
    if (!replyToken) return;
    try {
      await this.line.reply(replyToken, message);
    } catch (error) {
      this.store.appendAuditEvent({
        requestId,
        eventType: "LINE_REPLY_FAILED",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { error: String(error?.message ?? error).slice(0, 500) }
      });
    }
  }

  async #handlePairingCommand({ clientId, codeHash, userId, sourceType, replyToken }) {
    if (sourceType !== "user") {
      await this.#replySafely(replyToken, { type: "text", text: "กรุณาจับคู่ผู้อนุมัติในแชตส่วนตัวกับ LINE OA เท่านั้น" });
      return { paired: false, reason: "DIRECT_CHAT_REQUIRED" };
    }
    const client = this.#clientById(clientId);
    if (!client || client.linePairingEnabled !== true) {
      await this.#replySafely(replyToken, { type: "text", text: "จับคู่ไม่สำเร็จ กรุณาขอรหัสใหม่จากผู้ดูแลระบบ" });
      return { paired: false, reason: "PAIRING_UNAVAILABLE" };
    }
    if (this.store.isLineApprover({ clientId: client.id, lineUserId: userId })) {
      await this.#replySafely(replyToken, { type: "text", text: `LINE นี้เป็นผู้อนุมัติของ ${client.name} อยู่แล้ว` });
      return { paired: true, alreadyPaired: true, clientId: client.id };
    }
    try {
      this.store.consumeLinePairing({
        clientId: client.id,
        codeHash,
        lineUserId: userId,
        consumedAt: this.now()
      });
      await this.#replySafely(replyToken, {
        type: "text",
        text: `✅ จับคู่ผู้อนุมัติสำเร็จ\nลูกค้า: ${client.name}\nระบบจะส่งคำขอเพิ่มงบมาที่แชตนี้`
      });
      return { paired: true, alreadyPaired: false, clientId: client.id };
    } catch (error) {
      await this.#replySafely(replyToken, {
        type: "text",
        text: "จับคู่ไม่สำเร็จ รหัสอาจไม่ถูกต้อง หมดอายุ หรือถูกแทนที่แล้ว กรุณาขอรหัสใหม่"
      });
      return { paired: false, reason: error?.code ?? "PAIRING_FAILED" };
    }
  }

  async #handlePostback(event, userId) {
    const parsed = parsePostbackData(event.postback?.data);
    if (!parsed) return this.#replySafely(event.replyToken, { type: "text", text: "คำสั่งไม่ถูกต้อง กรุณาใช้ปุ่มจากข้อความล่าสุด" });
    const request = this.store.getBudgetRequest(parsed.requestId);
    if (!request || !request.authorizedLineUserIds.includes(userId)) {
      return this.#replySafely(event.replyToken, { type: "text", text: "ไม่พบคำขอ หรือคุณไม่มีสิทธิ์อนุมัติบัญชีนี้" });
    }

    if (parsed.action === "custom") {
      if (!allowsManualTarget(request)) {
        return this.#replySafely(event.replyToken, {
          type: "text",
          text: "คำขอนี้อนุญาตเฉพาะงบที่ระบบแนะนำ กรุณาใช้ปุ่มเพิ่มงบจากข้อความล่าสุด"
        }, request.id);
      }
      if (request.state !== RequestState.PENDING_INPUT) {
        return this.#replySafely(event.replyToken, { type: "text", text: "คำขอนี้กรอกงบแล้วหรือถูกปิดไปแล้ว" }, request.id);
      }
      const code = requestCodeFor(request.id);
      const maxBudget = fromMinor(request.guardrails.maxBudgetMinor, request.currency);
      return this.#replySafely(event.replyToken, {
        type: "text",
        text: `พิมพ์งบใหม่ทั้งก้อนในรูปแบบนี้:\nงบ ${code} ${maxBudget}\n\nงบต้องมากกว่างบปัจจุบันและไม่เกิน ${maxBudget} ${request.currency}\nคำขอจะหมดอายุ ${new Date(request.expiresAt).toLocaleTimeString("th-TH", { timeZone: request.metadata.timezone, hour: "2-digit", minute: "2-digit" })}`
      }, request.id);
    }

    if (parsed.action === "reject") {
      try {
        this.store.cancelBudgetRequest(request.id, { actorLineUserId: userId, reason: "Rejected in LINE", now: this.now() });
        return this.#replySafely(event.replyToken, { type: "text", text: "ยกเลิกคำขอเพิ่มงบแล้ว" }, request.id);
      } catch (error) {
        return this.#replySafely(event.replyToken, { type: "text", text: `คำขอนี้ดำเนินการไปแล้ว (${request.state})` }, request.id);
      }
    }

    if (parsed.action === "suggest") {
      if (request.state !== RequestState.PENDING_INPUT) {
        return this.#replySafely(event.replyToken, { type: "text", text: "คำขอนี้มีการระบุงบแล้ว กรุณายืนยันจากข้อความสรุปล่าสุดเท่านั้น" }, request.id);
      }
      try {
        const updated = this.store.submitBudgetAmount(request.id, {
          actorLineUserId: userId,
          increaseMinor: request.metadata.suggestedTargetMinor - request.currentBudgetMinor,
          now: this.now()
        });
        return this.#replySafely(event.replyToken, buildBudgetConfirmationMessage(this.#view(updated)), request.id);
      } catch (error) {
        const safe = safeError(error);
        return this.#replySafely(event.replyToken, { type: "text", text: `ไม่สามารถตั้งงบแนะนำได้: ${safe.message}` }, request.id);
      }
    }

    if (parsed.action === "confirm" && request.state === RequestState.PENDING_APPROVAL) {
      const now = this.now();
      if (now.getTime() >= Date.parse(request.expiresAt)) {
        try {
          this.store.expireBudgetRequest(request.id, { now });
        } catch (error) {
          if (!new Set(["CONCURRENT_MODIFICATION", "INVALID_STATE"]).has(error?.code)) throw error;
        }
        return this.#replySafely(event.replyToken, {
          type: "text",
          text: "คำขอนี้หมดอายุแล้ว ไม่มีการเปลี่ยนงบจริง"
        }, request.id);
      }
      if (parsed.version !== request.version) {
        return this.#replySafely(event.replyToken, { type: "text", text: "ข้อความยืนยันนี้เป็นเวอร์ชันเก่า กรุณาใช้ข้อความสรุปล่าสุด" }, request.id);
      }
      if (telemetryOnlyRequest(request)) {
        const completed = this.store.cancelBudgetRequest(request.id, {
          actorLineUserId: userId,
          reason: "Dry run: telemetry-only LINE confirmation",
          now
        });
        await this.#pushResult(userId, completed, {
          ok: true,
          dryRun: true,
          detail: "ยืนยันการทดสอบแล้ว—ไม่มีการเปลี่ยนงบจริงบน TikTok"
        });
        return this.#replySafely(event.replyToken, {
          type: "text",
          text: "จบการทดสอบแล้ว ✅ ไม่มีการเปลี่ยนงบจริงบน TikTok"
        }, request.id);
      }
      const queued = this.store.enqueueExecutionJob({
        requestId: request.id,
        actorLineUserId: userId,
        createdAt: now
      });
      return this.#replySafely(event.replyToken, {
        type: "text",
        text: queued.enqueued
          ? "รับคำยืนยันและบันทึกคิวถาวรแล้ว ระบบกำลังตรวจสอบบัญชีและงบล่าสุด…"
          : "คำขอนี้อยู่ในคิวแล้ว ระบบจะส่งผลกลับให้ทาง LINE"
      }, request.id);
    }

    return this.#replySafely(event.replyToken, { type: "text", text: `คำสั่งนี้ใช้ไม่ได้ในสถานะปัจจุบัน (${request.state})` }, request.id);
  }

  async #handleText(event, userId) {
    const pairing = parsePairingText(event.message?.text);
    if (pairing) {
      return this.#handlePairingCommand({
        clientId: pairing.clientId,
        codeHash: pairingCodeHash(pairing.clientId, pairing.code),
        userId,
        sourceType: event.source?.type ?? null,
        replyToken: event.replyToken
      });
    }
    const parsed = parseBudgetText(event.message?.text);
    if (!parsed) return;
    const candidates = this.store.listBudgetRequests({ state: RequestState.PENDING_INPUT, limit: 1000 });
    const matches = candidates.filter((item) => {
      try {
        return requestCodeFor(item.id) === parsed.requestCode && item.authorizedLineUserIds.includes(userId);
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) {
      return this.#replySafely(event.replyToken, { type: "text", text: "ไม่พบคำของบที่ยังเปิดอยู่ กรุณาใช้รหัสจากข้อความล่าสุด" });
    }
    const [request] = matches;
    if (!allowsManualTarget(request)) {
      return this.#replySafely(event.replyToken, {
        type: "text",
        text: "คำขอนี้ไม่อนุญาตให้กรอกงบเอง กรุณาใช้ปุ่มเพิ่มงบจากข้อความล่าสุด"
      }, request.id);
    }
    try {
      const targetMinor = toMinor(parsed.amount, request.currency);
      const updated = this.store.submitBudgetAmount(request.id, {
        actorLineUserId: userId,
        increaseMinor: targetMinor - request.currentBudgetMinor,
        now: this.now()
      });
      return this.#replySafely(event.replyToken, buildBudgetConfirmationMessage(this.#view(updated)), request.id);
    } catch (error) {
      const safe = safeError(error);
      return this.#replySafely(event.replyToken, { type: "text", text: `งบนี้ใช้ไม่ได้: ${safe.message}` }, request.id);
    }
  }

  async handleLineEvents(events) {
    const results = [];
    for (const event of events ?? []) {
      const eventId = webhookEventId(event);
      this.store.recordWebhookEvent({
        provider: "LINE",
        eventId,
        payload: {
          type: event.type,
          timestamp: event.timestamp ?? null,
          sourceType: event.source?.type ?? null,
          messageType: event.message?.type ?? null,
          isRedelivery: Boolean(event.deliveryContext?.isRedelivery),
          command: normalizedLineCommand(event)
        },
        receivedAt: this.now()
      });
      const claim = this.store.claimWebhookEvent({
        provider: "LINE",
        eventId,
        claimedAt: this.now(),
        leaseDurationMs: 10_000
      });
      if (!claim.claimed) {
        results.push({ eventId, status: claim.reason === "PROCESSED" ? "DUPLICATE" : "IN_PROGRESS" });
        continue;
      }
      const leaseToken = claim.event.leaseToken;
      const userId = event.source?.userId;
      try {
        if (!userId) {
          this.store.markWebhookEvent({ provider: "LINE", eventId, leaseToken, status: "PROCESSED", processedAt: this.now() });
          results.push({ eventId, status: "IGNORED_NO_USER" });
          continue;
        }
        if (event.type === "postback") await this.#handlePostback(event, userId);
        if (event.type === "message" && event.message?.type === "text") await this.#handleText(event, userId);
        this.store.markWebhookEvent({ provider: "LINE", eventId, leaseToken, status: "PROCESSED", processedAt: this.now() });
        results.push({ eventId, status: "PROCESSED" });
      } catch (error) {
        const safe = safeError(error);
        this.store.markWebhookEvent({
          provider: "LINE",
          eventId,
          leaseToken,
          status: "FAILED",
          errorCode: safe.code,
          processedAt: this.now()
        });
        results.push({ eventId, status: "FAILED", error: safe });
      }
    }
    return results;
  }

  async #sendRecoveredLineResponse(command, eventId) {
    let message = null;
    let requestId = null;
    if (command.kind === "postback") {
      const parsed = parsePostbackData(command.data);
      requestId = parsed?.requestId ?? null;
      const request = requestId ? this.store.getBudgetRequest(requestId) : null;
      if (!request || !request.authorizedLineUserIds.includes(command.userId)) return null;
      if (parsed?.action === "suggest" && request?.state === RequestState.PENDING_APPROVAL) {
        message = buildBudgetConfirmationMessage(this.#view(request));
      } else if (parsed?.action === "custom") {
        message = allowsManualTarget(request)
          ? { type: "text", text: "ระบบกู้คำสั่ง “กรอกงบเอง” แล้ว กรุณากดปุ่มจากข้อความล่าสุดอีกครั้งเพื่อรับรูปแบบและรหัสคำขอ" }
          : { type: "text", text: "คำขอนี้อนุญาตเฉพาะงบที่ระบบแนะนำ กรุณาใช้ปุ่มเพิ่มงบจากข้อความล่าสุด" };
      } else if (parsed?.action === "reject") {
        const rejected = request.state === RequestState.CANCELLED && request.cancellation?.reason === "Rejected in LINE";
        message = {
          type: "text",
          text: rejected
            ? "ระบบกู้คำสั่งแล้ว: คำขอเพิ่มงบถูกยกเลิก"
            : `ระบบกู้คำสั่งแล้ว แต่ไม่ได้ยกเลิกคำขอ เนื่องจากคำขออยู่ในสถานะ ${request.state}`
        };
      }
    } else if (command.kind === "budget_text") {
      const parsed = parseBudgetText(command.text);
      const matches = this.store.listBudgetRequests({ limit: 1000 })
        .filter((request) =>
          [RequestState.PENDING_INPUT, RequestState.PENDING_APPROVAL].includes(request.state) &&
          request.authorizedLineUserIds.includes(command.userId) &&
          requestCodeFor(request.id) === parsed?.requestCode
        );
      if (matches.length === 1) {
        requestId = matches[0].id;
        if (!allowsManualTarget(matches[0])) {
          message = { type: "text", text: "คำขอนี้ไม่อนุญาตให้กรอกงบเอง กรุณาใช้ปุ่มเพิ่มงบจากข้อความล่าสุด" };
        } else if (matches[0].state === RequestState.PENDING_APPROVAL) {
          message = buildBudgetConfirmationMessage(this.#view(matches[0]));
        }
      }
    } else if (command.kind === "pairing") {
      const client = this.#clientById(command.clientId);
      if (client && this.store.isLineApprover({ clientId: client.id, lineUserId: command.userId })) {
        message = { type: "text", text: `✅ ระบบกู้คำสั่งและยืนยันการจับคู่ผู้อนุมัติของ ${client.name} แล้ว` };
      }
    }
    if (!message) return requestId;
    const retryKey = stableRetryKey("webhook-recovery", eventId, command.userId);
    await this.line.push(command.userId, message, retryKey);
    this.store.appendAuditEvent({
      requestId,
      eventType: "LINE_WEBHOOK_RECOVERY_RESPONSE_SENT",
      actorType: "SYSTEM",
      occurredAt: this.now(),
      details: { eventId, retryKey }
    });
    return requestId;
  }

  async recoverLineWebhookEvents({ maxEvents = 20 } = {}) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) {
      throw new Error("maxEvents must be an integer between 1 and 1000");
    }
    const outcomes = [];
    const attemptedEventIds = [];
    for (let index = 0; index < maxEvents; index += 1) {
      const claim = this.store.claimNextWebhookEvent({
        provider: "LINE",
        claimedAt: this.now(),
        leaseDurationMs: 120_000,
        excludeEventIds: attemptedEventIds
      });
      if (!claim) break;
      const { event } = claim;
      attemptedEventIds.push(event.eventId);
      const command = event.payload.command;
      let requestId = null;
      try {
        if (command?.kind === "postback") {
          const parsed = parsePostbackData(command.data);
          requestId = parsed?.requestId ?? null;
          await this.#handlePostback({ type: "postback", source: { userId: command.userId }, postback: { data: command.data } }, command.userId);
        } else if (command?.kind === "budget_text") {
          await this.#handleText({ type: "message", source: { userId: command.userId }, message: { type: "text", text: command.text } }, command.userId);
        } else if (command?.kind === "pairing") {
          await this.#handlePairingCommand({
            clientId: command.clientId,
            codeHash: command.codeHash,
            userId: command.userId,
            sourceType: command.sourceType,
            replyToken: null
          });
        }
        requestId = (await this.#sendRecoveredLineResponse(command ?? {}, event.eventId)) ?? requestId;
        this.store.markWebhookEvent({
          provider: "LINE",
          eventId: event.eventId,
          leaseToken: event.leaseToken,
          status: "PROCESSED",
          requestId,
          processedAt: this.now()
        });
        outcomes.push({ eventId: event.eventId, status: "RECOVERED" });
      } catch (error) {
        const safe = safeError(error);
        this.store.markWebhookEvent({
          provider: "LINE",
          eventId: event.eventId,
          leaseToken: event.leaseToken,
          status: "FAILED",
          requestId,
          errorCode: safe.code,
          processedAt: this.now()
        });
        outcomes.push({ eventId: event.eventId, status: "FAILED", error: safe });
      }
    }
    return outcomes;
  }

  async #pushResult(userId, request, options) {
    const retryKey = stableRetryKey("budget-result", request.id, request.state, userId);
    try {
      await this.line.push(userId, buildResultMessage({ request: this.#view(request), ...options }), retryKey);
      this.store.appendAuditEvent({
        requestId: request.id,
        eventType: "LINE_RESULT_SENT",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { state: request.state, retryKey }
      });
    } catch (error) {
      this.store.appendAuditEvent({
        requestId: request.id,
        eventType: "LINE_RESULT_FAILED",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { state: request.state, retryKey, error: String(error?.message ?? error).slice(0, 500) }
      });
    }
  }

  async retryPendingResults({ limit = 1000 } = {}) {
    const outcomes = [];
    for (const state of [RequestState.SUCCEEDED, RequestState.FAILED, RequestState.CANCELLED]) {
      for (const request of this.store.listBudgetRequests({ state, limit })) {
        const cancellationNeedsResult = state === RequestState.CANCELLED && request.cancellation?.reason !== "Rejected in LINE";
        const userId = request.execution?.approvedByLineUserId ?? (
          cancellationNeedsResult ? request.cancellation?.actorLineUserId : null
        );
        if (!userId) continue;
        const alreadySent = this.store.listAuditEvents({ requestId: request.id, eventType: "LINE_RESULT_SENT", limit: 1000 })
          .some((event) => event.details.state === request.state);
        if (alreadySent) continue;
        await this.#pushResult(userId, request, {
          ok: state === RequestState.SUCCEEDED,
          dryRun: state === RequestState.CANCELLED && request.cancellation?.reason?.startsWith("Dry run:"),
          detail: state === RequestState.SUCCEEDED
            ? "ยืนยันจากงบจริงบน TikTok แล้ว"
            : state === RequestState.FAILED
              ? "โปรดตรวจ audit และงบจริงก่อนสร้างคำขอใหม่"
              : request.cancellation?.reason?.startsWith("Dry run:")
                ? "โหมดทดสอบ—ไม่มีการแก้งบจริง"
                : `ยกเลิกเพื่อความปลอดภัย: ${request.cancellation?.reason ?? "ข้อมูลเปลี่ยน"}`
        });
        outcomes.push({ requestId: request.id, state });
      }
    }
    return outcomes;
  }

  async executeApprovedRequest(requestId, userId) {
    let request = this.store.requireBudgetRequest(requestId);
    if (request.state !== RequestState.PENDING_APPROVAL) return request;

    if (telemetryOnlyRequest(request)) {
      request = this.store.cancelBudgetRequest(request.id, {
        actorLineUserId: userId,
        reason: "Dry run: telemetry-only execution blocked",
        now: this.now()
      });
      await this.#pushResult(userId, request, {
        ok: true,
        dryRun: true,
        detail: "คำขอ telemetry ไม่มีสิทธิ์เข้าถึง TikTok"
      });
      return request;
    }

    if (!this.executionEnabled) {
      request = this.store.cancelBudgetRequest(request.id, { actorLineUserId: userId, reason: "Dry run: EXECUTION_ENABLED=false", now: this.now() });
      await this.#pushResult(userId, request, { ok: true, dryRun: true, detail: "เปิด EXECUTION_ENABLED หลังผ่าน sandbox/low-budget test" });
      return request;
    }

    let claimed = false;
    let writeAttempted = false;
    let updateAccepted = false;
    try {
      const mapping = this.#currentExecutionMapping(request, userId);
      let info;
      if (mapping.dynamic) {
        const resolved = await this.#resolveDynamicCampaign(mapping.client);
        this.#assertDynamicAuthorityUnchanged(
          request.metadata.dynamicPolicy,
          resolved.campaign.dynamicPolicy
        );
        if (String(resolved.campaign.id) !== String(request.campaignId)) {
          throw new DomainError("DYNAMIC_CAMPAIGN_CHANGED", "Today's active LIVE campaign changed after the LINE request was created");
        }
        mapping.campaign = resolved.campaign;
        info = resolved.info;
      } else {
        info = await this.tiktok.getCampaignInfo({ advertiserId: request.adAccountId, campaignId: request.campaignId });
      }
      this.#assertCampaignIdentity(info, mapping.client, mapping.campaign);
      const observedMinor = toMinor(info.budget, request.currency);
      request = this.store.claimBudgetRequestForExecution(request.id, {
        actorLineUserId: userId,
        observedCurrentBudgetMinor: observedMinor,
        now: this.now()
      });
      claimed = true;

      if (mapping.dynamic) {
        const finalResolution = await this.#resolveDynamicCampaign(mapping.client);
        this.#assertDynamicAuthorityUnchanged(
          request.metadata.dynamicPolicy,
          finalResolution.campaign.dynamicPolicy
        );
        if (String(finalResolution.campaign.id) !== String(request.campaignId)) {
          throw new DomainError("DYNAMIC_CAMPAIGN_CHANGED", "Today's active LIVE campaign changed immediately before execution");
        }
        this.#assertCampaignIdentity(finalResolution.info, mapping.client, finalResolution.campaign);
        if (toMinor(finalResolution.info.budget, request.currency) !== request.currentBudgetMinor) {
          throw new DomainError("STALE_CURRENT_BUDGET", "TikTok budget changed immediately before execution");
        }
      }

      this.store.appendAuditEvent({
        requestId: request.id,
        eventType: "TIKTOK_UPDATE_ATTEMPTED",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { executionId: request.execution.id, targetBudgetMinor: request.targetBudgetMinor }
      });
      writeAttempted = true;
      const update = await this.tiktok.updateCampaignBudget({
        advertiserId: request.adAccountId,
        campaignId: request.campaignId,
        budget: fromMinor(request.targetBudgetMinor, request.currency)
      });
      updateAccepted = true;
      this.store.appendAuditEvent({
        requestId: request.id,
        eventType: "TIKTOK_UPDATE_ACCEPTED",
        actorType: "SYSTEM",
        occurredAt: this.now(),
        details: { requestId: update.requestId ?? null }
      });

      let verified;
      for (const waitMs of [0, 400, 1000]) {
        if (waitMs) await delay(waitMs);
        verified = await this.tiktok.getCampaignInfo({ advertiserId: request.adAccountId, campaignId: request.campaignId });
        this.#assertCampaignIdentity(verified, mapping.client, mapping.campaign);
        if (toMinor(verified.budget, request.currency) === request.targetBudgetMinor) break;
      }
      const verifiedMinor = toMinor(verified.budget, request.currency);
      request = this.store.succeedBudgetRequest(request.id, {
        actualBudgetMinor: verifiedMinor,
        platformReference: update.requestId,
        now: this.now()
      });
      await this.#pushResult(userId, request, { ok: true, detail: `TikTok request: ${update.requestId ?? "n/a"}` });
      return request;
    } catch (error) {
      const safe = safeError(error);
      request = this.store.getBudgetRequest(requestId) ?? request;
      const uncertainWrite = claimed && writeAttempted && request.state === RequestState.EXECUTING && (
        updateAccepted ||
        safe.outcomeKnown === false ||
        [
          "UNEXPECTED_PLATFORM_BUDGET",
          "ACCOUNT_MISMATCH",
          "CAMPAIGN_MISMATCH",
          "STORE_MISMATCH",
          "BUSINESS_CENTER_MISMATCH",
          "NOT_LIVE_GMV_MAX",
          "CAMPAIGN_NOT_ENABLED",
          "TIKTOK_ACCOUNT_MISMATCH",
          "TIKTOK_ACCOUNT_ID_AMBIGUOUS",
          "TIKTOK_ACCOUNT_ID_UNVERIFIED",
          "TIKTOK_MALFORMED_CAMPAIGN_INFO"
        ].includes(safe.code)
      );
      if (uncertainWrite) {
        this.store.appendAuditEvent({
          requestId: request.id,
          eventType: "TIKTOK_UPDATE_RECONCILIATION_REQUIRED",
          actorType: "SYSTEM",
          occurredAt: this.now(),
          details: { code: safe.code, requestId: safe.requestId, updateAccepted }
        });
        await this.#pushResult(userId, request, {
          ok: false,
          pending: true,
          detail: "ยังไม่สรุปว่าสำเร็จหรือล้มเหลว ระบบจะอ่านงบซ้ำและไม่เปิดคำขอใหม่ระหว่างนี้"
        });
        return request;
      }
      if (claimed && request.state === RequestState.EXECUTING) {
        request = this.store.failBudgetRequest(request.id, { code: safe.code, message: safe.message, retryable: false, now: this.now() });
      } else if ([
        "STALE_CURRENT_BUDGET",
        "ACCOUNT_MISMATCH",
        "CAMPAIGN_MISMATCH",
        "STORE_MISMATCH",
        "BUSINESS_CENTER_MISMATCH",
        "NOT_LIVE_GMV_MAX",
        "CAMPAIGN_NOT_ENABLED",
        "CONFIG_MAPPING_REVOKED",
        "APPROVER_REVOKED",
        "CONFIG_IDENTITY_CHANGED",
        "BUDGET_POLICY_CHANGED",
        "OUTSIDE_LIVE_WINDOW",
        "DYNAMIC_CAMPAIGN_CHANGED",
        "DYNAMIC_CAMPAIGN_AMBIGUOUS",
        "DYNAMIC_CAMPAIGN_NOT_FOUND",
        "DYNAMIC_CAMPAIGN_NAME_MISMATCH",
        "TIKTOK_ACCOUNT_MISMATCH",
        "TIKTOK_ACCOUNT_ID_AMBIGUOUS",
        "TIKTOK_ACCOUNT_ID_UNVERIFIED"
      ].includes(safe.code) && request.state === RequestState.PENDING_APPROVAL) {
        request = this.store.cancelBudgetRequest(request.id, { actorLineUserId: userId, reason: safe.code, now: this.now() });
      }
      await this.#pushResult(userId, request, { ok: false, detail: `${safe.code}: ${safe.message}` });
      return request;
    }
  }

  async processExecutionJobs({ maxJobs = 10 } = {}) {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) {
      throw new Error("maxJobs must be an integer between 1 and 100");
    }
    this.expireOldRequests();
    const outcomes = [];
    for (let processed = 0; processed < maxJobs; processed += 1) {
      const claim = this.store.claimNextExecutionJob({
        claimedAt: this.now(),
        leaseDurationMs: 5 * 60_000
      });
      if (!claim) break;
      const { job } = claim;
      try {
        let request = this.store.requireBudgetRequest(job.requestId);
        if (request.state === RequestState.PENDING_APPROVAL) {
          request = await this.executeApprovedRequest(job.requestId, job.actorLineUserId);
        } else if (request.state === RequestState.EXECUTING) {
          await this.recoverExecutingRequests();
          request = this.store.requireBudgetRequest(job.requestId);
        }

        if ([RequestState.SUCCEEDED, RequestState.FAILED, RequestState.EXPIRED, RequestState.CANCELLED].includes(request.state)) {
          this.store.completeExecutionJob({
            requestId: job.requestId,
            leaseToken: job.leaseToken,
            completedAt: this.now()
          });
          outcomes.push({ requestId: job.requestId, status: "COMPLETED", requestState: request.state });
          continue;
        }

        const backoffSeconds = Math.min(60, 5 * (2 ** Math.min(job.attemptCount - 1, 4)));
        this.store.releaseExecutionJob({
          requestId: job.requestId,
          leaseToken: job.leaseToken,
          availableAt: new Date(this.now().getTime() + backoffSeconds * 1000),
          releasedAt: this.now(),
          error: { code: request.state === RequestState.EXECUTING ? "RECONCILING" : "RETRY_PENDING_APPROVAL" }
        });
        outcomes.push({ requestId: job.requestId, status: "RETRY_SCHEDULED", requestState: request.state });
      } catch (error) {
        const safe = safeError(error);
        try {
          this.store.releaseExecutionJob({
            requestId: job.requestId,
            leaseToken: job.leaseToken,
            availableAt: new Date(this.now().getTime() + 30_000),
            releasedAt: this.now(),
            error: safe
          });
        } catch (releaseError) {
          this.logger.error("execution job release failed", {
            requestId: job.requestId,
            code: releaseError?.code,
            message: releaseError?.message
          });
        }
        outcomes.push({ requestId: job.requestId, status: "ERROR", error: safe });
      }
    }
    return outcomes;
  }

  async recoverExecutingRequests() {
    const results = [];
    for (const request of this.store.listBudgetRequests({ state: RequestState.EXECUTING, limit: 1000 })) {
      try {
        if (telemetryOnlyRequest(request)) {
          const failed = this.store.failBudgetRequest(request.id, {
            code: "TELEMETRY_ONLY_REQUEST",
            message: "Telemetry dry-run request cannot reach TikTok",
            retryable: false,
            now: this.now()
          });
          await this.#pushResult(request.execution.approvedByLineUserId, failed, {
            ok: false,
            dryRun: true,
            detail: "ปิดคำขอ telemetry ที่เข้าสถานะ execution โดยไม่มีการเรียก TikTok"
          });
          results.push({ requestId: request.id, status: "FAILED_TELEMETRY_ONLY" });
          continue;
        }
        const mapping = this.#requestMapping(request);
        const info = await this.tiktok.getCampaignInfo({ advertiserId: request.adAccountId, campaignId: request.campaignId });
        this.#assertCampaignIdentity(info, mapping.client, mapping.campaign);
        const actualBudgetMinor = toMinor(info.budget, request.currency);
        if (actualBudgetMinor === request.targetBudgetMinor) {
          const succeeded = this.store.succeedBudgetRequest(request.id, {
            actualBudgetMinor,
            platformReference: "reconciled-after-uncertain-write",
            now: this.now()
          });
          await this.#pushResult(request.execution.approvedByLineUserId, succeeded, {
            ok: true,
            detail: "ตรวจสอบงบจริงซ้ำแล้วและยืนยันผลสำเร็จ"
          });
          results.push({ requestId: request.id, status: "SUCCEEDED" });
        } else {
          const reconcileUntil = Date.parse(request.execution.startedAt) + this.config.reconciliationWindowMinutes * 60_000;
          if (this.now().getTime() < reconcileUntil) {
            results.push({
              requestId: request.id,
              status: "RETRY_LATER",
              observedBudgetMinor: actualBudgetMinor,
              reconcileUntil: new Date(reconcileUntil).toISOString()
            });
            continue;
          }
          const failed = this.store.failBudgetRequest(request.id, {
            code: "RECOVERY_BUDGET_MISMATCH",
            message: "TikTok budget did not match the approved target within the reconciliation window",
            retryable: false,
            now: this.now()
          });
          await this.#pushResult(request.execution.approvedByLineUserId, failed, {
            ok: false,
            detail: "พ้นช่วงตรวจสอบแล้ว แต่งบจริงยังไม่ตรงกับยอดที่อนุมัติ"
          });
          results.push({ requestId: request.id, status: "FAILED" });
        }
      } catch (error) {
        results.push({ requestId: request.id, status: "RETRY_LATER", error: safeError(error) });
      }
    }
    return results;
  }
}

export { calculateSuggestedTarget };
