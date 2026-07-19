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
  const reuseSharedBrowser = readBoolean(
    process.env.SPACECLOUD_RPA_REUSE_BROWSER,
    false,
  );
  return {
    headless,
    useProxy,
    // SpaceCloud write requests can reject a stale persistent browser profile
    // even while read requests still succeed. Prefer a fresh isolated context;
    // shared reuse remains an explicit opt-in for controlled diagnostics.
    reuse: headless && useProxy && reuseSharedBrowser,
  };
}
