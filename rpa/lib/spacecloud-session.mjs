import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  ensureParentDir,
  spaceCloudSessionMetaPath,
} from "./paths.mjs";

function readBoolean(value, fallback) {
  const normalized = value?.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function readSpaceCloudSessionMeta() {
  if (!existsSync(spaceCloudSessionMetaPath)) return null;

  try {
    const value = JSON.parse(readFileSync(spaceCloudSessionMetaPath, "utf8"));
    if (!["proxy", "direct"].includes(value?.networkMode)) return null;
    return value;
  } catch {
    return null;
  }
}

export function saveSpaceCloudSessionMeta({ useProxy }) {
  ensureParentDir(spaceCloudSessionMetaPath);
  const value = {
    networkMode: useProxy ? "proxy" : "direct",
    savedAt: new Date().toISOString(),
  };
  writeFileSync(spaceCloudSessionMetaPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value;
}

export function shouldUseSpaceCloudProxy() {
  const explicit = process.env.SPACECLOUD_RPA_USE_PROXY;
  if (explicit?.trim()) return readBoolean(explicit, false);
  return readSpaceCloudSessionMeta()?.networkMode === "proxy";
}

export function spaceCloudBrowserOptions(headless) {
  const useProxy = shouldUseSpaceCloudProxy();
  return {
    headless,
    useProxy,
    // The shared Chromium currently follows the proxy network. A locally
    // authenticated SpaceCloud session must use an isolated direct browser.
    reuse: headless && useProxy,
  };
}
