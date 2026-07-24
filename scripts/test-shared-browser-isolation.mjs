import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeSharedBrowserRole,
  sharedBrowserRuntimePaths,
} from "../rpa/lib/browser.mjs";

assert.equal(normalizeSharedBrowserRole(" NAVER "), "naver");
assert.equal(normalizeSharedBrowserRole("spacecloud"), "spacecloud");
assert.throws(() => normalizeSharedBrowserRole("generic"), /isolated role/);

const naver = sharedBrowserRuntimePaths("naver");
const spacecloud = sharedBrowserRuntimePaths("spacecloud");

for (const key of ["statePath", "startLockPath", "profileDir", "logPath"]) {
  assert.notEqual(naver[key], spacecloud[key], `${key} must be isolated by service`);
}

const naverDetail = await readFile(
  new URL("../rpa/naver-read-booking-detail.mjs", import.meta.url),
  "utf8",
);
const naverSlots = await readFile(
  new URL("../rpa/naver-toggle-slots.mjs", import.meta.url),
  "utf8",
);
const spacecloudSession = await readFile(
  new URL("../rpa/lib/spacecloud-session.mjs", import.meta.url),
  "utf8",
);
const browserService = await readFile(
  new URL("../ops/systemd/memoroom-rpa-browser@.service", import.meta.url),
  "utf8",
);
const appService = await readFile(
  new URL("../ops/systemd/memoroom-app.service", import.meta.url),
  "utf8",
);

for (const source of [naverDetail, naverSlots]) {
  assert.match(source, /sharedBrowserRole:\s*"naver"/);
}
assert.match(spacecloudSession, /sharedBrowserRole:\s*"spacecloud"/);
assert.match(browserService, /--role=%i/);
assert.match(browserService, /Restart=always/);
assert.match(appService, /RPA_SHARED_BROWSER_SYSTEMD_MANAGED=true/);
assert.match(appService, /SPACECLOUD_RPA_REUSE_BROWSER=true/);

console.log("Shared RPA browser isolation tests passed.");
