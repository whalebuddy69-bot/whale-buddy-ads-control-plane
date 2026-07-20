import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

test("manifest uses MV3 and only the approved minimal permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["alarms", "storage", "tabGroups"]);
  for (const forbidden of ["tabs", "scripting", "cookies", "webRequest", "debugger", "identity", "nativeMessaging"]) {
    assert.equal(manifest.permissions.includes(forbidden), false);
  }
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://ads.tiktok.com/i18n/gmv-max/dashboard*"
  ]);
  assert.deepEqual(manifest.content_scripts[0].js, [
    "lib/refresh-safety.js",
    "lib/tiktok-parser.js",
    "content/tiktok-live-gmv-max.js"
  ]);
});

test("service worker keeps the Chrome campaign ID boundary explicit", async () => {
  const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  assert.match(source, /campaignId:\s*null/u);
  assert.doesNotMatch(source, /chrome\.(?:cookies|debugger|webRequest|scripting)/u);
});

test("refresh fallback is visible, configurable, and manual check does not claim freshness", async () => {
  const options = await readFile(new URL("../ui/options.html", import.meta.url), "utf8");
  const popup = await readFile(new URL("../ui/popup.html", import.meta.url), "utf8");
  assert.match(options, /id="page-refresh-enabled"/u);
  assert.match(options, /value="2">ทุก 2 นาที/u);
  assert.match(options, /เมื่อเชื่อม TikTok API แล้วให้กลับมาปิด/u);
  assert.match(options, /อ่านค่าหน้าปัจจุบัน \(ไม่รีเฟรช\)/u);
  assert.match(popup, /Page-refresh fallback/u);
  assert.match(popup, /อ่านค่าหน้าปัจจุบัน/u);
});
