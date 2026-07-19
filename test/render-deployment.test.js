import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateConfig } from "../src/config.js";

const projectRoot = new URL("../", import.meta.url);

function readProjectFile(relativePath) {
  return fs.readFileSync(new URL(relativePath, projectRoot), "utf8");
}

test("checked-in Render pilot config is valid and contains no credential fields", () => {
  const source = readProjectFile("config/punpan_020.control-plane.json");
  const config = validateConfig(JSON.parse(source));

  assert.equal(config.clients.length, 1);
  assert.equal(config.clients[0].id, "punpan_020");
  assert.equal(config.clients[0].linePairingEnabled, true);
  assert.equal(config.clients[0].budgetPolicy.maxDailyBudget, 6000);
  assert.doesNotMatch(source, /access[_-]?token|channel[_-]?secret|api[_-]?key|password/i);
});

test("Render Blueprint is locked to the safe single-instance control plane", () => {
  const blueprint = readProjectFile("render.yaml");

  for (const expected of [
    "runtime: docker",
    "plan: starter",
    "region: singapore",
    "numInstances: 1",
    "healthCheckPath: /health",
    "mountPath: /app/data",
    "sizeGB: 1",
    "value: /app/config/punpan_020.control-plane.json",
    "value: /app/data/gmv-max.sqlite"
  ]) {
    assert.match(blueprint, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const flag of [
    "CONTROL_PLANE_ONLY",
    "EXECUTION_ENABLED",
    "MONITOR_ENABLED",
    "STARTUP_VALIDATION_ENABLED",
    "CHROME_TELEMETRY_ENABLED"
  ]) {
    const value = ["CONTROL_PLANE_ONLY", "CHROME_TELEMETRY_ENABLED"].includes(flag)
      ? "true"
      : "false";
    assert.match(blueprint, new RegExp(`- key: ${flag}\\n\\s+value: [\"']${value}[\"']`));
  }

  assert.match(
    blueprint,
    /- key: CHROME_TELEMETRY_MAX_CLOCK_SKEW_SECONDS\n\s+value: [\"']300[\"']/
  );

  assert.match(blueprint, /- key: ADMIN_API_KEY\n\s+generateValue: true/);
  assert.match(blueprint, /- key: LINE_CHANNEL_SECRET\n\s+sync: false/);
  assert.match(blueprint, /- key: LINE_CHANNEL_ACCESS_TOKEN\n\s+sync: false/);
  assert.doesNotMatch(blueprint, /TIKTOK_ACCESS_TOKEN/);
});

test("production image uses Node 22 and copies only the non-secret deployment config", () => {
  const dockerfile = readProjectFile("Dockerfile");

  assert.match(dockerfile, /^FROM node:22-alpine$/m);
  assert.match(dockerfile, /COPY --chown=node:node config\/punpan_020\.control-plane\.json/);
  assert.doesNotMatch(dockerfile, /^COPY config \.\/config$/m);
  assert.match(dockerfile, /^USER node$/m);
});
