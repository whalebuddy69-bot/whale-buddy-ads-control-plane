const encoder = new TextEncoder();

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(value) {
  return bytesToHex(await sha256Bytes(value));
}

export async function generateDeviceKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  );
  if (pair.privateKey.extractable || !pair.publicKey.extractable) {
    throw new Error("DEVICE_KEY_SECURITY_INVARIANT");
  }
  return pair;
}

export async function exportPublicKeyJwk(publicKey) {
  const exported = await crypto.subtle.exportKey("jwk", publicKey);
  return {
    kty: "EC",
    crv: "P-256",
    x: exported.x,
    y: exported.y,
    ext: true,
    key_ops: ["verify"]
  };
}

export function randomBase64Url(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function signingTimestamp(now = new Date()) {
  const value = String(Math.floor(new Date(now).getTime() / 1000));
  if (!/^\d{10}$/u.test(value)) throw new Error("CLOCK_OUT_OF_RANGE");
  return value;
}

export async function buildSigningMessage({ credentialId, timestamp, nonce, rawBody }) {
  const bodyHash = await sha256Hex(rawBody);
  return encoder.encode(`v1\n${credentialId}\n${timestamp}\n${nonce}\n${bodyHash}`);
}

export async function signRequest({ privateKey, credentialId, rawBody, now = new Date(), nonce }) {
  const timestamp = signingTimestamp(now);
  const requestNonce = nonce ?? randomBase64Url(16);
  const message = await buildSigningMessage({
    credentialId,
    timestamp,
    nonce: requestNonce,
    rawBody
  });
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    message
  ));
  // WebCrypto ECDSA uses the raw IEEE-P1363 r||s representation expected by
  // the backend. A DER signature must never be sent here.
  if (signature.length !== 64) throw new Error("INVALID_ECDSA_SIGNATURE_FORMAT");
  return {
    timestamp,
    nonce: requestNonce,
    signature: `v1=${bytesToBase64Url(signature)}`
  };
}

export async function telemetryUiCampaignRef({ advertiserId, campaignName }) {
  return `ui:${await sha256Hex(`${advertiserId}\0${campaignName}`)}`;
}
