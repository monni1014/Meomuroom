import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  ensureParentDir,
  spaceCloudSessionMetaPath,
  spaceCloudStorageStatePath,
} from "./paths.mjs";
import { acquireProcessLock } from "./process-lock.mjs";

const SPACECLOUD_PARTNER_ORIGIN = "https://partner.spacecloud.kr";
const SPACECLOUD_REFRESH_URL = "https://api.spacecloud.kr/partner/users/get_token";
const DEFAULT_REFRESH_BEFORE_MS = 6 * 60 * 60 * 1000;
const MIN_VALID_ACCESS_TOKEN_MS = 60 * 1000;

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

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function decodeJwtExpiresAt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return Number.isFinite(payload?.exp) ? Number(payload.exp) * 1000 : null;
  } catch {
    return null;
  }
}

function findSpaceCloudUserInfoEntry(state) {
  const origin = state?.origins?.find((item) => item.origin === SPACECLOUD_PARTNER_ORIGIN);
  return origin?.localStorage?.find((item) => item.name === "spacecloud__userInfo") || null;
}

function findSpaceCloudRefreshCookie(state) {
  return state?.cookies?.find((cookie) => (
    cookie.name === "refresh_token"
    && /(?:^|\.)spacecloud\.kr$/i.test(cookie.domain || "")
  )) || null;
}

export function inspectSpaceCloudStorageState(state, nowMs = Date.now()) {
  const userInfoEntry = findSpaceCloudUserInfoEntry(state);
  const userInfo = userInfoEntry ? parseJson(userInfoEntry.value) : null;
  const accessToken = typeof userInfo?.accessToken === "string" ? userInfo.accessToken : "";
  const accessTokenExpiresAt = decodeJwtExpiresAt(accessToken);
  const refreshCookie = findSpaceCloudRefreshCookie(state);
  const refreshTokenExpiresAt = refreshCookie?.expires > 0
    ? refreshCookie.expires * 1000
    : null;

  return {
    hasAccessToken: Boolean(accessToken),
    accessTokenExpiresAt,
    accessTokenRemainingMs: accessTokenExpiresAt === null ? null : accessTokenExpiresAt - nowMs,
    hasRefreshToken: Boolean(refreshCookie),
    refreshTokenExpiresAt,
    refreshTokenRemainingMs: refreshTokenExpiresAt === null ? null : refreshTokenExpiresAt - nowMs,
  };
}

export function shouldRefreshSpaceCloudAccessToken(
  state,
  {
    nowMs = Date.now(),
    refreshBeforeMs = DEFAULT_REFRESH_BEFORE_MS,
  } = {},
) {
  const session = inspectSpaceCloudStorageState(state, nowMs);
  if (!session.hasAccessToken || session.accessTokenExpiresAt === null) return true;
  return session.accessTokenExpiresAt <= nowMs + refreshBeforeMs;
}

export function applySpaceCloudAccessTokenToStorageState(state, accessToken) {
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("SpaceCloud refreshed access token was empty.");
  }

  let updated = false;
  const origins = (state?.origins || []).map((origin) => {
    if (origin.origin !== SPACECLOUD_PARTNER_ORIGIN) return origin;

    const localStorage = (origin.localStorage || []).map((entry) => {
      if (entry.name !== "spacecloud__userInfo") return entry;
      const userInfo = parseJson(entry.value);
      if (!userInfo || typeof userInfo !== "object") {
        throw new Error("SpaceCloud saved user information could not be parsed.");
      }
      updated = true;
      return {
        ...entry,
        value: JSON.stringify({ ...userInfo, accessToken }),
      };
    });

    return { ...origin, localStorage };
  });

  if (!updated) {
    throw new Error("SpaceCloud saved user information was missing.");
  }

  return { ...state, origins };
}

function writeJsonAtomically(filePath, value) {
  ensureParentDir(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    // Windows cannot always replace an existing file with rename. The Linux
    // production path uses the atomic rename above; keep local tests portable.
    if (!(["EEXIST", "EPERM"].includes(error?.code))) throw error;
    rmSync(filePath, { force: true });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function recordSessionCheckpoint(session, reason) {
  const previous = readSpaceCloudSessionMeta() || {};
  writeJsonAtomically(spaceCloudSessionMetaPath, {
    ...previous,
    networkMode: previous.networkMode || "proxy",
    savedAt: new Date().toISOString(),
    lastCheckpointReason: reason,
    accessTokenExpiresAt: session.accessTokenExpiresAt === null
      ? null
      : new Date(session.accessTokenExpiresAt).toISOString(),
    refreshTokenExpiresAt: session.refreshTokenExpiresAt === null
      ? null
      : new Date(session.refreshTokenExpiresAt).toISOString(),
  });
}

export async function persistSpaceCloudStorageState(
  state,
  {
    reason = "authenticated-rpa",
    nowMs = Date.now(),
  } = {},
) {
  const candidate = inspectSpaceCloudStorageState(state, nowMs);
  if (
    !candidate.hasAccessToken
    || candidate.accessTokenExpiresAt === null
    || candidate.accessTokenRemainingMs <= MIN_VALID_ACCESS_TOKEN_MS
  ) {
    throw new Error("SpaceCloud login required. Refusing to save an expired access token.");
  }
  if (
    !candidate.hasRefreshToken
    || candidate.refreshTokenExpiresAt === null
    || candidate.refreshTokenRemainingMs <= 0
  ) {
    throw new Error("SpaceCloud login required. Refresh token is missing or expired.");
  }

  if (existsSync(spaceCloudStorageStatePath)) {
    const currentState = parseJson(readFileSync(spaceCloudStorageStatePath, "utf8"));
    const current = inspectSpaceCloudStorageState(currentState, nowMs);
    const currentIsNewer =
      (current.accessTokenExpiresAt || 0) > (candidate.accessTokenExpiresAt || 0)
      && (current.refreshTokenExpiresAt || 0) >= (candidate.refreshTokenExpiresAt || 0);
    if (currentIsNewer) {
      return { saved: false, reason: "newer-session-already-saved", session: current };
    }
  }

  writeJsonAtomically(spaceCloudStorageStatePath, state);
  recordSessionCheckpoint(candidate, reason);
  return { saved: true, reason, session: candidate };
}

function refreshBeforeMsFromEnv() {
  const hours = Number(process.env.SPACECLOUD_ACCESS_TOKEN_REFRESH_BEFORE_HOURS || "6");
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_REFRESH_BEFORE_MS;
  return hours * 60 * 60 * 1000;
}

export async function ensureSpaceCloudAccessToken(context, {
  nowMs = Date.now(),
  refreshBeforeMs = refreshBeforeMsFromEnv(),
} = {}) {
  const state = await context.storageState({ indexedDB: true });
  const session = inspectSpaceCloudStorageState(state, nowMs);
  if (
    !session.hasRefreshToken
    || session.refreshTokenExpiresAt === null
    || session.refreshTokenExpiresAt <= nowMs
  ) {
    throw new Error("SpaceCloud login required. Refresh token is missing or expired.");
  }

  if (!shouldRefreshSpaceCloudAccessToken(state, { nowMs, refreshBeforeMs })) {
    console.log(`[SpaceCloud session] Access token is valid until ${new Date(session.accessTokenExpiresAt).toISOString()}.`);
    return { refreshed: false, session };
  }

  console.log("[SpaceCloud session] Renew the access token with the saved refresh token.");
  const response = await context.request.get(SPACECLOUD_REFRESH_URL, {
    failOnStatusCode: false,
    headers: { Accept: "application/json" },
    timeout: 30_000,
  });
  if (!response.ok()) {
    throw new Error(
      `SpaceCloud login required. Refresh token was rejected with ${response.status()}.`,
    );
  }

  const payload = await response.json().catch(() => null);
  const accessToken = typeof payload?.token === "string" ? payload.token : "";
  const accessTokenExpiresAt = decodeJwtExpiresAt(accessToken);
  if (!accessToken || accessTokenExpiresAt === null || accessTokenExpiresAt <= nowMs + MIN_VALID_ACCESS_TOKEN_MS) {
    throw new Error("SpaceCloud login required. Token renewal returned an invalid access token.");
  }

  await context.addInitScript(({ origin, token }) => {
    if (location.origin !== origin) return;
    try {
      const userInfo = JSON.parse(localStorage.getItem("spacecloud__userInfo") || "null");
      if (!userInfo || typeof userInfo !== "object") return;
      localStorage.setItem("spacecloud__userInfo", JSON.stringify({
        ...userInfo,
        accessToken: token,
      }));
    } catch {
      // The caller validates and persists the patched storage state separately.
    }
  }, { origin: SPACECLOUD_PARTNER_ORIGIN, token: accessToken });

  const refreshedContextState = await context.storageState({ indexedDB: true });
  const refreshedState = applySpaceCloudAccessTokenToStorageState(
    refreshedContextState,
    accessToken,
  );
  const persisted = await persistSpaceCloudStorageState(refreshedState, {
    reason: "access-token-refresh",
    nowMs,
  });
  console.log(`[SpaceCloud session] Access token renewed until ${new Date(accessTokenExpiresAt).toISOString()} and session checkpoint ${persisted.saved ? "saved" : "kept"}.`);
  return { refreshed: true, session: persisted.session };
}

export async function checkpointSpaceCloudSession(context, reason = "authenticated-rpa") {
  const state = await context.storageState({ indexedDB: true });
  const result = await persistSpaceCloudStorageState(state, { reason });
  console.log(`[SpaceCloud session] Session checkpoint ${result.saved ? "saved" : "kept"} (${reason}).`);
  return result;
}

export function acquireSpaceCloudSessionUseLock(label = "SpaceCloud authenticated RPA") {
  return acquireProcessLock("rpa/.locks/spacecloud-session-use.lock", {
    label,
    timeoutMs: 12 * 60 * 1000,
    staleMs: 15 * 60 * 1000,
  });
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
