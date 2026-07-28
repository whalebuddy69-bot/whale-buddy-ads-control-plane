import { decryptSecretJson } from "./secret-box.js";
import { TikTokClient } from "./tiktok.js";

const READ_ONLY_METHODS = Object.freeze([
  "getAdvertiserInfo",
  "getCampaignInfo",
  "getGmvMaxStores",
  "getGmvMaxIdentities",
  "getGmvMaxBidRecommendation",
  "getLiveCampaigns",
  "getTodayCampaignSpend"
]);

function requiredId(value, name) {
  const normalized = String(value ?? "");
  if (!/^[1-9]\d{5,30}$/.test(normalized)) {
    throw new Error(`${name} must be a TikTok numeric ID`);
  }
  return normalized;
}

export function tiktokCredentialAad({ credentialRef, appId, clientId }) {
  if (typeof credentialRef !== "string" || credentialRef.length < 8) {
    throw new Error("credentialRef is invalid");
  }
  return `tiktok-oauth:v1:${credentialRef}:${requiredId(appId, "appId")}:${String(clientId ?? "")}`;
}

export class TikTokCredentialRouter {
  #encryptionKey;

  constructor({
    store,
    encryptionKey,
    appId,
    credentialOwnerId,
    fetchImpl = globalThis.fetch,
    baseUrl,
    timeoutMs,
    ClientClass = TikTokClient
  }) {
    if (!store || typeof store.getTikTokCredentialByAdvertiserId !== "function") {
      throw new Error("TikTok credential store is required");
    }
    this.store = store;
    this.#encryptionKey = encryptionKey;
    this.appId = requiredId(appId, "appId");
    this.credentialOwnerId = String(credentialOwnerId ?? "");
    if (this.credentialOwnerId.length < 1 || this.credentialOwnerId.length > 256) {
      throw new Error("credentialOwnerId is required");
    }
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.ClientClass = ClientClass;
  }

  credentialStatus(advertiserId) {
    const normalizedAdvertiserId = requiredId(advertiserId, "advertiserId");
    const credential = this.store.getTikTokCredentialByAdvertiserId(normalizedAdvertiserId);
    if (!credential) return { connected: false, advertiserId: normalizedAdvertiserId };
    if (credential.appId !== this.appId || credential.clientId !== this.credentialOwnerId) {
      const error = new Error("TikTok credential belongs to a different app or agency");
      error.code = "TIKTOK_CREDENTIAL_OWNER_MISMATCH";
      throw error;
    }
    if (!credential.advertiserIds.includes(normalizedAdvertiserId)) {
      const error = new Error("TikTok credential mapping is inconsistent");
      error.code = "TIKTOK_CREDENTIAL_MAPPING_INVALID";
      throw error;
    }
    const secrets = decryptSecretJson(credential.encryptedBlob, {
      key: this.#encryptionKey,
      aad: tiktokCredentialAad(credential)
    });
    const expiresAt = secrets?.expiresAt ?? null;
    if (
      expiresAt !== null
      && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)))
    ) {
      const error = new Error("TikTok credential expiry metadata is invalid");
      error.code = "TIKTOK_CREDENTIAL_METADATA_INVALID";
      throw error;
    }
    return {
      connected: true,
      advertiserId: normalizedAdvertiserId,
      credentialRef: credential.credentialRef,
      authorizedAt: credential.createdAt,
      expiresAt
    };
  }

  clientForAdvertiser(advertiserId) {
    const normalizedAdvertiserId = requiredId(advertiserId, "advertiserId");
    const credential = this.store.getTikTokCredentialByAdvertiserId(normalizedAdvertiserId);
    if (!credential) {
      const error = new Error("TikTok API has not been authorized for this ad account");
      error.code = "TIKTOK_CREDENTIAL_NOT_FOUND";
      throw error;
    }
    if (
      credential.appId !== this.appId
      || credential.clientId !== this.credentialOwnerId
      || !credential.advertiserIds.includes(normalizedAdvertiserId)
    ) {
      const error = new Error("TikTok credential binding failed validation");
      error.code = "TIKTOK_CREDENTIAL_BINDING_INVALID";
      throw error;
    }
    const secrets = decryptSecretJson(credential.encryptedBlob, {
      key: this.#encryptionKey,
      aad: tiktokCredentialAad(credential)
    });
    const expiresAtMs = secrets?.expiresAt == null ? null : Date.parse(secrets.expiresAt);
    if (
      typeof secrets?.accessToken !== "string"
      || secrets.accessToken.length < 16
      || (expiresAtMs !== null && (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()))
    ) {
      const error = new Error("TikTok credential is missing or expired");
      error.code = "TIKTOK_CREDENTIAL_EXPIRED";
      throw error;
    }
    const client = new this.ClientClass({
      accessToken: secrets.accessToken,
      fetchImpl: this.fetchImpl,
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs
    });
    const readOnly = {};
    for (const method of READ_ONLY_METHODS) {
      if (typeof client[method] !== "function") {
        const error = new Error(`TikTok read-only adapter omitted ${method}`);
        error.code = "TIKTOK_READ_ADAPTER_INCOMPLETE";
        throw error;
      }
      readOnly[method] = (...args) => client[method](...args);
    }
    return Object.freeze(readOnly);
  }
}
