import crypto from "node:crypto";

import { encryptSecretJson } from "./secret-box.js";
import { tiktokCredentialAad } from "./tiktok-credential-router.js";
import { TikTokOAuthError } from "./tiktok-oauth.js";
import { runLiveGmvMaxPreflight } from "./tiktok-preflight.js";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function nonceHash(nonce) {
  return crypto.createHash("sha256").update(nonce, "utf8").digest("hex");
}

function untrustedNonceFromState(state) {
  try {
    if (typeof state !== "string" || state.length < 3 || state.length > 8_192) throw new Error();
    const pieces = state.split(".");
    if (pieces.length !== 2) throw new Error();
    const payload = JSON.parse(Buffer.from(pieces[0], "base64url").toString("utf8"));
    if (!NONCE_PATTERN.test(payload?.nonce)) throw new Error();
    return payload.nonce;
  } catch {
    throw new TikTokOAuthError("Invalid or expired TikTok OAuth state", {
      code: "TIKTOK_OAUTH_INVALID_STATE",
      operation: "callback",
      outcomeKnown: true
    });
  }
}

function sameIdSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function isoFromSeconds(now, seconds) {
  return seconds == null ? null : new Date(now.getTime() + seconds * 1_000).toISOString();
}

function clientMatchLines(config, advertiserIds) {
  const granted = new Set(advertiserIds);
  return config.clients
    .filter((client) => client.lineControl?.enabled === true)
    .map((client) => {
      const alias = client.lineControl.aliases?.[0] ?? client.name;
      const suffix = String(client.advertiserId).slice(-6);
      return `${granted.has(String(client.advertiserId)) ? "✅" : "⚠️"} ${alias} · …${suffix}`;
    });
}

export function buildTikTokOAuthConnectedMessage({ config, advertiserIds }) {
  const matched = config.clients.filter((client) => advertiserIds.includes(String(client.advertiserId)));
  const lines = [
    "✅ เชื่อม TikTok API สำเร็จ",
    `Ad Account ที่อนุญาต: ${advertiserIds.length} บัญชี`,
    `ตรงกับ Client ในระบบ: ${matched.length}/${config.clients.length}`,
    ...clientMatchLines(config, advertiserIds),
    "",
    "ขั้นต่อไปพิมพ์: ตรวจสอบ TikTok API Ppan"
  ];
  return { type: "text", text: lines.join("\n").slice(0, 5_000) };
}

export function buildTikTokPreflightMessage({ client, result }) {
  const heading = result.decision === "DISCOVERY_REQUIRED"
    ? "🔎 พบ API Binding — รอยืนยันและ Pin"
    : "⛔ ยังไม่พร้อมเปิดการยิงจริง";
  const lines = [
    heading,
    `ลูกค้า: ${client.name}`,
    `Ad Account: …${String(result.advertiserId).slice(-6)}`,
    `ผลตรวจ: ${result.reason}`
  ];
  if (result.advertiser) {
    lines.push(
      `Account context: ${result.advertiser.currency} · ${result.advertiser.timezone} · ${result.advertiser.accountStatus}`
    );
  }
  if (result.storeId) {
    lines.push(`Shop: …${String(result.storeId).slice(-6)}`);
    lines.push(`Business Center: …${String(result.storeAuthorizedBcId).slice(-6)}`);
  }
  if (result.identityCandidates) {
    lines.push(`API identity candidates: ${result.identityCandidates.length}`);
  }
  for (const identity of (result.identityCandidates ?? []).slice(0, 5)) {
    const label = identity.displayName ?? identity.userName;
    lines.push(
      `API Identity: …${String(identity.identityId).slice(-6)} · ${identity.identityType}${label ? ` · ${label}` : ""}`
    );
  }
  if (result.campaignCandidates) {
    lines.push(`LIVE campaign candidates: ${result.campaignCandidates.length}`);
    for (const campaign of result.campaignCandidates.slice(0, 5)) {
      lines.push(
        `• ${campaign.campaignName ?? `…${String(campaign.campaignId).slice(-6)}`} · ${campaign.primaryStatus ?? "ต้องตรวจสถานะ"}`
      );
    }
  }
  lines.push(
    "ระบบยังเป็น read-only และยังไม่อนุญาตให้สร้าง/แก้ไข ต้องยืนยัน Shop, BC และ API Identity ก่อน"
  );
  return { type: "text", text: lines.join("\n").slice(0, 5_000) };
}

export class TikTokApiControl {
  #encryptionKey;
  #oauthAdminLineUserIds;

  constructor({
    oauthClient,
    credentialRouter,
    store,
    line,
    config,
    appId,
    agencyId = config?.agencyId,
    oauthAdminLineUserIds,
    encryptionKey,
    now = () => new Date(),
    logger = console
  }) {
    if (!oauthClient || !credentialRouter || !store || !line || !config) {
      throw new Error("TikTok API control dependencies are required");
    }
    this.oauthClient = oauthClient;
    this.credentialRouter = credentialRouter;
    this.store = store;
    this.line = line;
    this.config = config;
    this.appId = String(appId ?? "");
    this.agencyId = String(agencyId ?? "");
    if (!Array.isArray(oauthAdminLineUserIds) || oauthAdminLineUserIds.length === 0) {
      throw new Error("oauthAdminLineUserIds must contain at least one explicit agency admin");
    }
    this.#oauthAdminLineUserIds = new Set(oauthAdminLineUserIds.map((value) => String(value)));
    if (
      this.#oauthAdminLineUserIds.size !== oauthAdminLineUserIds.length
      || [...this.#oauthAdminLineUserIds].some((value) => value === "")
    ) {
      throw new Error("oauthAdminLineUserIds must contain unique non-empty IDs");
    }
    this.#encryptionKey = encryptionKey;
    this.now = now;
    this.logger = logger;
    if (!this.appId || !this.agencyId) throw new Error("TikTok appId and agencyId are required");
  }

  #isAgencyOAuthApprover(lineUserId) {
    return this.#oauthAdminLineUserIds.has(lineUserId);
  }

  #assertAgencyOAuthApprover(lineUserId) {
    if (!this.#isAgencyOAuthApprover(lineUserId)) {
      const error = new Error(
        "เฉพาะผู้ดูแล Agency ที่ระบุไว้เท่านั้นที่เชื่อม TikTok API ได้"
      );
      error.code = "TIKTOK_OAUTH_AGENCY_APPROVER_REQUIRED";
      throw error;
    }
  }

  createAuthorizationRequest({ lineUserId }) {
    if (typeof lineUserId !== "string" || lineUserId === "") {
      throw new Error("lineUserId is required");
    }
    this.#assertAgencyOAuthApprover(lineUserId);
    const request = this.oauthClient.createAuthorizationRequest();
    this.store.createTikTokOAuthState({
      clientId: this.agencyId,
      lineUserId,
      nonceHash: nonceHash(request.nonce),
      createdAt: new Date(request.issuedAt),
      expiresAt: new Date(request.expiresAt)
    });
    return {
      url: request.url,
      expiresAt: new Date(request.expiresAt).toISOString()
    };
  }

  async completeAuthorization({ authCode, state }) {
    const nonce = untrustedNonceFromState(state);
    const hash = nonceHash(nonce);
    const savedState = this.store.getTikTokOAuthStateByNonceHash(hash);
    if (!savedState || savedState.clientId !== this.agencyId) {
      throw new TikTokOAuthError("Invalid or expired TikTok OAuth state", {
        code: "TIKTOK_OAUTH_INVALID_STATE",
        operation: "callback",
        outcomeKnown: true
      });
    }
    this.#assertAgencyOAuthApprover(savedState.lineUserId);
    this.oauthClient.verifyAuthorizationState({ state, expectedNonce: nonce });
    const at = this.now();
    this.store.consumeTikTokOAuthState({
      clientId: this.agencyId,
      lineUserId: savedState.lineUserId,
      nonceHash: hash,
      consumedAt: at
    });
    const token = await this.oauthClient.exchangeAuthorizationCode({
      authCode,
      state,
      expectedNonce: nonce
    });
    const grant = await this.oauthClient.getAdvertiserGrant({
      accessToken: token.accessToken
    });
    this.#assertAgencyOAuthApprover(savedState.lineUserId);
    if (grant.advertiserIds.length === 0) {
      throw new TikTokOAuthError("TikTok authorization did not grant any ad accounts", {
        code: "TIKTOK_OAUTH_EMPTY_GRANT",
        requestId: grant.requestId,
        operation: "callback",
        outcomeKnown: true
      });
    }
    if (token.advertiserIds.length > 0 && !sameIdSet(token.advertiserIds, grant.advertiserIds)) {
      throw new TikTokOAuthError("TikTok token and advertiser grant do not match", {
        code: "TIKTOK_OAUTH_GRANT_MISMATCH",
        requestId: grant.requestId,
        operation: "callback",
        outcomeKnown: true
      });
    }

    const credentialRef = `ttcred_${crypto.randomUUID()}`;
    const expiresAt = isoFromSeconds(at, token.expiresInSeconds);
    const refreshTokenExpiresAt = isoFromSeconds(at, token.refreshTokenExpiresInSeconds);
    const metadata = {
      credentialRef,
      clientId: this.agencyId,
      appId: this.appId
    };
    const encryptedBlob = encryptSecretJson({
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      tokenType: token.tokenType,
      scopes: token.scopes,
      expiresAt,
      refreshTokenExpiresAt
    }, {
      key: this.#encryptionKey,
      aad: tiktokCredentialAad(metadata)
    });
    this.store.saveTikTokCredential({
      ...metadata,
      advertiserIds: grant.advertiserIds,
      encryptedBlob,
      createdAt: at,
      updatedAt: at
    });
    this.store.appendAuditEvent({
      eventType: "TIKTOK_OAUTH_COMPLETED",
      actorType: "LINE_USER",
      actorId: savedState.lineUserId,
      occurredAt: at,
      details: {
        stateId: savedState.stateId,
        credentialRef,
        agencyId: this.agencyId,
        advertiserIds: [...grant.advertiserIds],
        scopes: [...token.scopes],
        tokenRequestId: token.requestId ?? null,
        grantRequestId: grant.requestId ?? null
      }
    });

    let notificationSent = true;
    try {
      await this.line.push(
        savedState.lineUserId,
        buildTikTokOAuthConnectedMessage({
          config: this.config,
          advertiserIds: grant.advertiserIds
        }),
        crypto.randomUUID()
      );
    } catch (error) {
      notificationSent = false;
      this.logger.error("tiktok oauth completion notification failed", {
        code: error?.code ?? "LINE_PUSH_FAILED"
      });
    }
    return {
      credentialRef,
      advertiserIds: [...grant.advertiserIds],
      authorizedByLineUserId: savedState.lineUserId,
      expiresAt,
      notificationSent
    };
  }

  async preflightClient(client) {
    const tiktok = this.credentialRouter.clientForAdvertiser(client.advertiserId);
    return runLiveGmvMaxPreflight({
      tiktok,
      advertiserId: client.advertiserId,
      expectedTikTokAccountId: client.campaignSelector.expectedTikTokAccountId,
      expectedBusinessCenterId: client.telemetry.businessCenterId,
      expectedCurrency: client.campaignSelector.currency,
      expectedTimezone: client.timezone
    });
  }
}
