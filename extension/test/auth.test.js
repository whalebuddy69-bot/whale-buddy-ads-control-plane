import assert from "node:assert/strict";
import cryptoNode from "node:crypto";
import test from "node:test";
import {
  buildSigningMessage,
  bytesToBase64Url,
  exportPublicKeyJwk,
  generateDeviceKeyPair,
  signRequest,
  telemetryUiCampaignRef
} from "../lib/auth.js";

test("device private key is non-extractable and public enrollment JWK has no private material", async () => {
  const pair = await generateDeviceKeyPair();
  assert.equal(pair.privateKey.extractable, false);
  assert.equal(pair.publicKey.extractable, true);
  const jwk = await exportPublicKeyJwk(pair.publicKey);
  assert.deepEqual(jwk.key_ops, ["verify"]);
  assert.equal(jwk.crv, "P-256");
  assert.equal("d" in jwk, false);
  await assert.rejects(() => crypto.subtle.exportKey("jwk", pair.privateKey));
});

test("request signature is raw 64-byte P-256 over the backend canonical message", async () => {
  const pair = await generateDeviceKeyPair();
  const credentialId = "tc_12345678-1234-1234-1234-123456789abc";
  const rawBody = new TextEncoder().encode('{"snapshotId":"ts_test"}');
  const nonce = bytesToBase64Url(new Uint8Array(16).fill(7));
  const now = new Date("2026-07-20T12:00:00.000Z");
  const signed = await signRequest({ privateKey: pair.privateKey, credentialId, rawBody, nonce, now });
  assert.equal(signed.signature.startsWith("v1="), true);
  const signature = Buffer.from(signed.signature.slice(3), "base64url");
  assert.equal(signature.length, 64);
  const message = await buildSigningMessage({
    credentialId,
    timestamp: signed.timestamp,
    nonce,
    rawBody
  });
  assert.equal(await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pair.publicKey,
    signature,
    message
  ), true);
});

test("UI campaignRef is deterministic and contains no invented campaign ID", async () => {
  const advertiserId = "7646832328389263378";
  const campaignName = "2026-07-20 06:00:00";
  const expected = cryptoNode.createHash("sha256")
    .update(advertiserId)
    .update("\0")
    .update(campaignName)
    .digest("hex");
  assert.equal(await telemetryUiCampaignRef({ advertiserId, campaignName }), `ui:${expected}`);
});
