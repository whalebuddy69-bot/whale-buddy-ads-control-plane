import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { verifyLineSignature } from "./line.js";
import { BudgetGuardService } from "./service.js";
import { SqliteStore } from "./store.js";
import { TikTokClient } from "./tiktok.js";
import { LineClient } from "./line.js";
import {
  TelemetryError,
  telemetryCredentialIdFromHeaders,
  telemetryEnrollmentCodeHash,
  telemetryPayloadHash,
  validateTelemetryEnrollmentRequest,
  validateTelemetrySnapshot,
  verifyTelemetryRequest
} from "./telemetry.js";

const MAX_BODY_BYTES = 1_000_000;

function environmentFlag(environment, name, fallback = false) {
  const value = environment[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function resolveRuntimeMode(environment = process.env) {
  const controlPlaneOnly = environmentFlag(environment, "CONTROL_PLANE_ONLY", false);
  const chromeTelemetryEnabled = environmentFlag(environment, "CHROME_TELEMETRY_ENABLED", false);
  return {
    controlPlaneOnly,
    executionEnabled: controlPlaneOnly
      ? false
      : environmentFlag(environment, "EXECUTION_ENABLED", false),
    monitorEnabled: controlPlaneOnly
      ? false
      : environmentFlag(environment, "MONITOR_ENABLED", false),
    startupValidationEnabled: controlPlaneOnly
      ? false
      : environmentFlag(environment, "STARTUP_VALIDATION_ENABLED", true),
    adapters: {
      line: { enabled: true, source: "messaging-api" },
      tiktok: {
        enabled: !controlPlaneOnly,
        source: controlPlaneOnly ? null : "business-api"
      },
      chromeTelemetry: {
        enabled: chromeTelemetryEnabled,
        source: chromeTelemetryEnabled ? "signed-http-p256" : null,
        status: chromeTelemetryEnabled ? "waiting-for-snapshot" : "disabled"
      }
    }
  };
}

export function resolveTelemetryOptions(environment = process.env) {
  const maxClockSkewSeconds = Number(environment.CHROME_TELEMETRY_MAX_CLOCK_SKEW_SECONDS ?? 300);
  if (!Number.isInteger(maxClockSkewSeconds) || maxClockSkewSeconds < 30 || maxClockSkewSeconds > 900) {
    throw new Error("CHROME_TELEMETRY_MAX_CLOCK_SKEW_SECONDS must be an integer between 30 and 900");
  }
  return Object.freeze({ maxClockSkewSeconds });
}

export function requiredEnvironmentVariables(runtime) {
  const required = ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "ADMIN_API_KEY"];
  if (!runtime.controlPlaneOnly) required.push("TIKTOK_ACCESS_TOKEN");
  return required;
}

export function assertRuntimeCompatibility(config, runtime) {
  const chromeUiClients = config.clients
    .filter((client) => client.telemetry?.source === "chrome-ui")
    .map((client) => client.id);
  if (!runtime.controlPlaneOnly && chromeUiClients.length > 0) {
    throw new Error(
      `chrome-ui telemetry ingestion cannot drive TikTok runtime monitoring; set CONTROL_PLANE_ONLY=true for clients: ${chromeUiClients.join(", ")}`
    );
  }
  if (runtime.adapters.chromeTelemetry.enabled && chromeUiClients.length === 0) {
    throw new Error("CHROME_TELEMETRY_ENABLED requires at least one client with telemetry.source=chrome-ui");
  }
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function telemetryHttpStatus(error) {
  if (error instanceof TelemetryError) return error.status;
  if (["TELEMETRY_REPLAY", "TELEMETRY_SNAPSHOT_CONFLICT"].includes(error?.code)) return 409;
  if (error?.code === "TELEMETRY_CREDENTIAL_REVOKED") return 401;
  if (error?.code === "INVALID_REQUEST") return 400;
  return null;
}

function telemetryHealth({ runtimeStatus, config, store, now }) {
  const adapter = runtimeStatus.adapters.chromeTelemetry;
  if (!adapter.enabled) return adapter;
  const clients = (config?.clients ?? []).filter((client) => client.telemetry?.source === "chrome-ui");
  const latest = store.listLatestTelemetry({ limit: 1000 });
  const latestByClient = new Map(latest.map((snapshot) => [snapshot.clientId, snapshot]));
  const nowMilliseconds = new Date(now).getTime();
  let freshClients = 0;
  let staleClients = 0;
  let reportingClients = 0;
  let latestObservedAt = null;
  for (const client of clients) {
    const snapshot = latestByClient.get(client.id);
    if (!snapshot) continue;
    reportingClients += 1;
    if (latestObservedAt === null || snapshot.observedAt > latestObservedAt) {
      latestObservedAt = snapshot.observedAt;
    }
    const age = nowMilliseconds - Date.parse(snapshot.observedAt);
    if (age <= client.telemetry.maxSnapshotAgeSeconds * 1000) freshClients += 1;
    else staleClients += 1;
  }
  const status = reportingClients === 0
    ? "waiting-for-snapshot"
    : staleClients > 0 || freshClients < clients.length
      ? "degraded"
      : "healthy";
  return {
    ...adapter,
    status,
    configuredClients: clients.length,
    reportingClients,
    freshClients,
    staleClients,
    latestObservedAt
  };
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function adminAuthorized(request, expectedKey) {
  if (!expectedKey) return false;
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  const suppliedHash = crypto.createHash("sha256").update(supplied).digest();
  const expectedHash = crypto.createHash("sha256").update(expectedKey).digest();
  return crypto.timingSafeEqual(suppliedHash, expectedHash);
}

export function lineWebhookHttpStatus(results) {
  return (results ?? []).some((result) => ["FAILED", "IN_PROGRESS"].includes(result?.status)) ? 500 : 200;
}

export function createHttpServer({
  service,
  store,
  channelSecret,
  adminApiKey,
  runtime,
  config = { clients: [] },
  telemetryOptions = { maxClockSkewSeconds: 300 },
  clock = () => new Date(),
  logger = console
}) {
  const adminRateWindows = new Map();
  const enrollmentRateWindows = new Map();
  const runtimeStatus = runtime ?? {
    controlPlaneOnly: false,
    executionEnabled: Boolean(service.executionEnabled),
    monitorEnabled: false,
    startupValidationEnabled: false,
    adapters: {
      line: { enabled: true, source: "messaging-api" },
      tiktok: { enabled: true, source: "business-api" },
      chromeTelemetry: { enabled: false, source: null, status: "disabled" }
    }
  };
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const adapters = {
          ...runtimeStatus.adapters,
          chromeTelemetry: telemetryHealth({ runtimeStatus, config, store, now: clock() })
        };
        return jsonResponse(response, 200, {
          ok: true,
          service: "live-gmv-max-guard",
          controlPlaneOnly: runtimeStatus.controlPlaneOnly,
          executionEnabled: runtimeStatus.executionEnabled,
          monitorEnabled: runtimeStatus.monitorEnabled,
          adapters
        });
      }

      if (request.method === "POST" && url.pathname === "/webhooks/line") {
        const rawBody = await readBody(request);
        if (!verifyLineSignature(rawBody, request.headers["x-line-signature"], channelSecret)) {
          return jsonResponse(response, 401, { ok: false, error: "invalid LINE signature" });
        }
        let payload;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return jsonResponse(response, 400, { ok: false, error: "invalid JSON" });
        }
        const results = await service.handleLineEvents(payload.events);
        const status = lineWebhookHttpStatus(results);
        return jsonResponse(response, status, { ok: status === 200, results });
      }

      if (request.method === "POST" && url.pathname === "/telemetry/chrome/enroll") {
        if (!runtimeStatus.adapters.chromeTelemetry.enabled) {
          return jsonResponse(response, 503, { ok: false, error: "TELEMETRY_DISABLED" });
        }
        const remote = request.socket.remoteAddress ?? "unknown";
        const nowMilliseconds = new Date(clock()).getTime();
        const bucket = enrollmentRateWindows.get(remote);
        if (!bucket || nowMilliseconds - bucket.startedAt >= 60_000) {
          enrollmentRateWindows.set(remote, { startedAt: nowMilliseconds, count: 1 });
        } else {
          bucket.count += 1;
          if (bucket.count > 20) return jsonResponse(response, 429, { ok: false, error: "rate_limited" });
        }
        const rawBody = await readBody(request);
        const input = validateTelemetryEnrollmentRequest(JSON.parse(rawBody.toString("utf8")));
        let credential;
        try {
          credential = store.consumeTelemetryEnrollment({
            clientId: input.clientId,
            codeHash: telemetryEnrollmentCodeHash(input.enrollmentCode),
            installationId: input.installationId,
            publicKeyJwk: input.publicKeyJwk,
            consumedAt: clock()
          });
        } catch (error) {
          if (error?.code === "TELEMETRY_ENROLLMENT_INVALID") {
            return jsonResponse(response, 401, {
              ok: false,
              error: "TELEMETRY_ENROLLMENT_INVALID",
              message: "Enrollment code is invalid or expired"
            });
          }
          throw error;
        }
        return jsonResponse(response, 201, {
          ok: true,
          credentialId: credential.credentialId,
          clientId: credential.clientId,
          binding: {
            browserProfile: credential.browserProfile,
            tabGroup: credential.tabGroup,
            businessCenterId: credential.businessCenterId,
            sellerMode: credential.sellerMode,
            pageType: credential.pageType
          }
        });
      }

      if (request.method === "POST" && url.pathname === "/telemetry/chrome/snapshots") {
        if (!runtimeStatus.adapters.chromeTelemetry.enabled) {
          return jsonResponse(response, 503, { ok: false, error: "TELEMETRY_DISABLED" });
        }
        const rawBody = await readBody(request);
        const credentialId = telemetryCredentialIdFromHeaders(request.headers);
        const credential = credentialId ? store.getTelemetryCredential(credentialId) : null;
        const auth = verifyTelemetryRequest({
          rawBody,
          headers: request.headers,
          credential,
          now: clock(),
          maxClockSkewSeconds: telemetryOptions.maxClockSkewSeconds
        });
        const snapshot = validateTelemetrySnapshot(JSON.parse(rawBody.toString("utf8")), {
          config,
          credential,
          now: clock(),
          maxFutureSkewSeconds: telemetryOptions.maxClockSkewSeconds
        });
        const receivedAt = new Date(clock());
        const recorded = store.recordTelemetrySnapshot({
          snapshot,
          credentialId: auth.credentialId,
          nonce: auth.nonce,
          payloadHash: telemetryPayloadHash(rawBody),
          receivedAt,
          pruneNoncesBefore: new Date(
            receivedAt.getTime() - (telemetryOptions.maxClockSkewSeconds * 2 + 60) * 1000
          )
        });
        return jsonResponse(response, recorded.duplicate ? 200 : 202, {
          ok: true,
          accepted: true,
          duplicate: recorded.duplicate,
          latest: recorded.latest,
          snapshotId: recorded.snapshot.snapshotId,
          observedAt: recorded.snapshot.observedAt
        });
      }

      if (url.pathname.startsWith("/admin/")) {
        const remote = request.socket.remoteAddress ?? "unknown";
        const now = Date.now();
        const bucket = adminRateWindows.get(remote);
        if (!bucket || now - bucket.startedAt >= 60_000) {
          adminRateWindows.set(remote, { startedAt: now, count: 1 });
        } else {
          bucket.count += 1;
          if (bucket.count > 60) return jsonResponse(response, 429, { ok: false, error: "rate_limited" });
        }
        if (!adminAuthorized(request, adminApiKey)) {
          return jsonResponse(response, 401, { ok: false, error: "unauthorized" });
        }
      }

      if (request.method === "POST" && url.pathname === "/admin/poll") {
        if (runtimeStatus.controlPlaneOnly) {
          return jsonResponse(response, 503, {
            ok: false,
            error: "CONTROL_PLANE_ONLY",
            message: "Polling is unavailable until a supported telemetry adapter is configured"
          });
        }
        store.appendAuditEvent({ eventType: "ADMIN_POLL_REQUESTED", actorType: "ADMIN", occurredAt: new Date(), details: {} });
        const outcomes = await service.pollOnce();
        return jsonResponse(response, 200, { ok: true, outcomes });
      }

      if (request.method === "POST" && url.pathname === "/admin/line-pairings") {
        const rawBody = await readBody(request);
        const input = JSON.parse(rawBody.toString("utf8"));
        const pairing = service.createLinePairing({
          clientId: String(input.clientId ?? ""),
          ttlMinutes: input.ttlMinutes == null ? 10 : Number(input.ttlMinutes)
        });
        return jsonResponse(response, 201, {
          ok: true,
          clientId: pairing.clientId,
          command: pairing.command,
          expiresAt: pairing.expiresAt
        });
      }

      if (request.method === "POST" && url.pathname === "/admin/telemetry/enrollments") {
        if (!runtimeStatus.adapters.chromeTelemetry.enabled) {
          return jsonResponse(response, 503, { ok: false, error: "TELEMETRY_DISABLED" });
        }
        const rawBody = await readBody(request);
        const input = JSON.parse(rawBody.toString("utf8"));
        const clientId = String(input.clientId ?? "");
        const client = config.clients.find((candidate) =>
          candidate.id === clientId && candidate.telemetry?.source === "chrome-ui"
        );
        if (!client) {
          return jsonResponse(response, 404, { ok: false, error: "TELEMETRY_CLIENT_NOT_FOUND" });
        }
        const ttlMinutes = input.ttlMinutes == null ? 10 : Number(input.ttlMinutes);
        if (!Number.isInteger(ttlMinutes) || ttlMinutes < 2 || ttlMinutes > 60) {
          return jsonResponse(response, 400, {
            ok: false,
            error: "INVALID_REQUEST",
            message: "ttlMinutes must be an integer between 2 and 60"
          });
        }
        const enrollmentCode = crypto.randomBytes(32).toString("base64url");
        const createdAt = new Date(clock());
        const enrollment = store.createTelemetryEnrollment({
          clientId,
          codeHash: telemetryEnrollmentCodeHash(enrollmentCode),
          browserProfile: client.telemetry.browserProfile,
          tabGroup: client.telemetry.tabGroup,
          businessCenterId: client.telemetry.businessCenterId,
          sellerMode: client.telemetry.sellerMode,
          pageType: client.telemetry.pageType,
          createdAt,
          expiresAt: new Date(createdAt.getTime() + ttlMinutes * 60_000)
        });
        return jsonResponse(response, 201, {
          ok: true,
          enrollmentId: enrollment.enrollmentId,
          clientId,
          enrollmentCode,
          expiresAt: enrollment.expiresAt,
          binding: {
            browserProfile: enrollment.browserProfile,
            tabGroup: enrollment.tabGroup,
            businessCenterId: enrollment.businessCenterId,
            sellerMode: enrollment.sellerMode,
            pageType: enrollment.pageType
          }
        });
      }

      if (request.method === "GET" && url.pathname === "/admin/telemetry/latest") {
        const clientId = url.searchParams.get("clientId") ?? undefined;
        const limitText = url.searchParams.get("limit");
        const limit = limitText == null ? 100 : Number(limitText);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          return jsonResponse(response, 400, { ok: false, error: "INVALID_REQUEST" });
        }
        if (clientId !== undefined && !config.clients.some((client) => client.id === clientId)) {
          return jsonResponse(response, 404, { ok: false, error: "TELEMETRY_CLIENT_NOT_FOUND" });
        }
        const snapshots = store.listLatestTelemetry({ clientId, limit });
        store.appendAuditEvent({
          eventType: "CHROME_TELEMETRY_ADMIN_READ",
          actorType: "ADMIN",
          occurredAt: clock(),
          details: { clientId: clientId ?? null, resultCount: snapshots.length }
        });
        return jsonResponse(response, 200, {
          ok: true,
          snapshots: snapshots.map((snapshot) => ({
            ...snapshot,
            spendRatio: snapshot.costMinor / snapshot.dailyBudgetMinor
          }))
        });
      }

      if (request.method === "POST" && url.pathname === "/admin/requests") {
        if (runtimeStatus.controlPlaneOnly) {
          return jsonResponse(response, 503, {
            ok: false,
            error: "CONTROL_PLANE_ONLY",
            message: "Budget requests are unavailable until a supported TikTok execution adapter is configured"
          });
        }
        const rawBody = await readBody(request);
        const input = JSON.parse(rawBody.toString("utf8"));
        const requestRecord = await service.createManualRequest({
          advertiserId: String(input.advertiserId ?? ""),
          campaignId: String(input.campaignId ?? ""),
          proposedBudget: Number(input.proposedBudget)
        });
        store.appendAuditEvent({
          requestId: requestRecord.id,
          eventType: "ADMIN_REQUEST_CREATED",
          actorType: "ADMIN",
          occurredAt: new Date(),
          details: {}
        });
        return jsonResponse(response, 201, { ok: true, requestId: requestRecord.id, state: requestRecord.state, expiresAt: requestRecord.expiresAt });
      }

      const requestMatch = request.method === "GET" && url.pathname.match(/^\/admin\/requests\/([a-zA-Z0-9_-]+)$/);
      if (requestMatch) {
        const record = store.getBudgetRequest(requestMatch[1]);
        if (!record) return jsonResponse(response, 404, { ok: false, error: "not found" });
        store.appendAuditEvent({
          requestId: record.id,
          eventType: "ADMIN_REQUEST_READ",
          actorType: "ADMIN",
          occurredAt: new Date(),
          details: {}
        });
        return jsonResponse(response, 200, { ok: true, request: record, audit: store.listAuditEvents({ requestId: record.id }) });
      }

      return jsonResponse(response, 404, { ok: false, error: "not found" });
    } catch (error) {
      const status = error.status ?? telemetryHttpStatus(error) ?? (error instanceof SyntaxError ? 400 : 500);
      logger.error("http error", { method: request.method, path: url.pathname, status, code: error.code, message: error.message });
      return jsonResponse(response, status, { ok: false, error: error.code ?? "internal_error", message: status < 500 ? error.message : "Internal error" });
    }
  });
}

export async function startFromEnvironment() {
  const runtime = resolveRuntimeMode(process.env);
  const telemetryOptions = resolveTelemetryOptions(process.env);
  const required = requiredEnvironmentVariables(runtime);
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  if (process.env.ADMIN_API_KEY.length < 43) {
    throw new Error("ADMIN_API_KEY must contain at least 32 random bytes (43+ base64url characters)");
  }

  const config = loadConfig();
  assertRuntimeCompatibility(config, runtime);
  const databasePath = path.resolve(process.env.DATABASE_PATH ?? "./data/gmv-max.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const store = new SqliteStore(databasePath);
  fs.chmodSync(databasePath, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const sqliteSidecar = `${databasePath}${suffix}`;
    if (fs.existsSync(sqliteSidecar)) fs.chmodSync(sqliteSidecar, 0o600);
  }
  const line = new LineClient({ accessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
  const tiktok = runtime.adapters.tiktok.enabled
    ? new TikTokClient({
        accessToken: process.env.TIKTOK_ACCESS_TOKEN,
        baseUrl: process.env.TIKTOK_API_BASE_URL
      })
    : null;
  const service = new BudgetGuardService({
    config,
    store,
    line,
    tiktok,
    executionEnabled: runtime.executionEnabled
  });
  const server = createHttpServer({
    service,
    store,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    adminApiKey: process.env.ADMIN_API_KEY,
    runtime,
    config,
    telemetryOptions
  });

  if (!runtime.controlPlaneOnly) {
    if (runtime.startupValidationEnabled) {
      await service.validateConfiguredAccess();
    }
    await service.recoverExecutingRequests();
  }
  let mutationWorkerBusy = false;
  const runExecutionWorker = async () => {
    if (mutationWorkerBusy) return;
    mutationWorkerBusy = true;
    try {
      await service.processExecutionJobs({ maxJobs: 10 });
    } catch (error) {
      console.error(JSON.stringify({ event: "execution_worker_error", code: error?.code, message: error?.message }));
    } finally {
      mutationWorkerBusy = false;
    }
  };
  let executionWorkerTimer;
  if (!runtime.controlPlaneOnly) {
    executionWorkerTimer = setInterval(runExecutionWorker, 2_000);
    executionWorkerTimer.unref();
  }

  const runReconciliation = async () => {
    if (mutationWorkerBusy) return;
    mutationWorkerBusy = true;
    try {
      await service.recoverExecutingRequests();
    } catch (error) {
      console.error(JSON.stringify({ event: "reconciliation_error", code: error?.code, message: error?.message }));
    } finally {
      mutationWorkerBusy = false;
    }
  };
  let reconciliationTimer;
  if (!runtime.controlPlaneOnly) {
    reconciliationTimer = setInterval(runReconciliation, 15_000);
    reconciliationTimer.unref();
  }

  let notificationWorkerBusy = false;
  const runNotificationWorker = async () => {
    if (notificationWorkerBusy) return;
    notificationWorkerBusy = true;
    try {
      await service.recoverLineWebhookEvents({ maxEvents: 20 });
      await service.retryPendingAlerts({ limit: 100 });
      await service.retryPendingResults({ limit: 1000 });
    } catch (error) {
      console.error(JSON.stringify({ event: "notification_worker_error", code: error?.code, message: error?.message }));
    } finally {
      notificationWorkerBusy = false;
    }
  };
  const notificationWorkerTimer = setInterval(runNotificationWorker, 10_000);
  notificationWorkerTimer.unref();
  let monitorBusy = false;
  let monitorTimer;
  if (runtime.monitorEnabled) {
    const runMonitor = async () => {
      if (monitorBusy) return;
      monitorBusy = true;
      try {
        await service.pollOnce();
      } finally {
        monitorBusy = false;
      }
    };
    await runMonitor();
    monitorTimer = setInterval(runMonitor, config.pollIntervalSeconds * 1000);
    monitorTimer.unref();
  }

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(JSON.stringify({
    event: "server_started",
    host,
    port,
    controlPlaneOnly: runtime.controlPlaneOnly,
    monitorEnabled: Boolean(monitorTimer),
    executionEnabled: service.executionEnabled,
    adapters: runtime.adapters
  }));
  if (!runtime.controlPlaneOnly) setImmediate(runExecutionWorker);
  setImmediate(runNotificationWorker);

  const shutdown = () => {
    if (monitorTimer) clearInterval(monitorTimer);
    if (executionWorkerTimer) clearInterval(executionWorkerTimer);
    if (reconciliationTimer) clearInterval(reconciliationTimer);
    clearInterval(notificationWorkerTimer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { server, service, store, runtime };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnvironment().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
