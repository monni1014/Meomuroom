import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applySpaceCloudAccessTokenToStorageState,
  decodeJwtExpiresAt,
  inspectSpaceCloudStorageState,
  mergeSpaceCloudStorageState,
  shouldRefreshSpaceCloudAccessToken,
} from "../rpa/lib/spacecloud-session.mjs";

function jwtWithExpiration(exp) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}

function storageState({ accessExp, refreshExp }) {
  return {
    cookies: [{
      name: "refresh_token",
      value: "redacted-refresh-token",
      domain: ".spacecloud.kr",
      path: "/",
      expires: refreshExp,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    }],
    origins: [{
      origin: "https://partner.spacecloud.kr",
      localStorage: [{
        name: "spacecloud__userInfo",
        value: JSON.stringify({
          id: "host",
          name: "Memoroom",
          accessToken: jwtWithExpiration(accessExp),
        }),
      }],
    }],
  };
}

const nowSeconds = 2_000_000_000;
const nowMs = nowSeconds * 1000;
const state = storageState({
  accessExp: nowSeconds + 24 * 60 * 60,
  refreshExp: nowSeconds + 30 * 24 * 60 * 60,
});

assert.equal(decodeJwtExpiresAt(jwtWithExpiration(nowSeconds + 3600)), nowMs + 3600 * 1000);
assert.equal(decodeJwtExpiresAt("not-a-jwt"), null);

const inspected = inspectSpaceCloudStorageState(state, nowMs);
assert.equal(inspected.hasAccessToken, true);
assert.equal(inspected.hasRefreshToken, true);
assert.equal(inspected.accessTokenRemainingMs, 24 * 60 * 60 * 1000);
assert.equal(inspected.refreshTokenRemainingMs, 30 * 24 * 60 * 60 * 1000);
assert.equal(
  shouldRefreshSpaceCloudAccessToken(state, { nowMs, refreshBeforeMs: 6 * 60 * 60 * 1000 }),
  false,
);
assert.equal(
  shouldRefreshSpaceCloudAccessToken(state, { nowMs, refreshBeforeMs: 25 * 60 * 60 * 1000 }),
  true,
);

const renewedToken = jwtWithExpiration(nowSeconds + 48 * 60 * 60);
const renewedState = applySpaceCloudAccessTokenToStorageState(state, renewedToken);
const renewedEntry = renewedState.origins[0].localStorage.find(
  (entry) => entry.name === "spacecloud__userInfo",
);
assert.equal(JSON.parse(renewedEntry.value).accessToken, renewedToken);
assert.notEqual(renewedState, state);

const mergedState = mergeSpaceCloudStorageState({
  cookies: [{
    name: "live_cookie",
    value: "live",
    domain: ".spacecloud.kr",
    path: "/",
  }],
  origins: [],
}, state);
assert.equal(mergedState.cookies.some((cookie) => cookie.name === "live_cookie"), true);
assert.equal(mergedState.cookies.some((cookie) => cookie.name === "refresh_token"), true);
assert.equal(inspectSpaceCloudStorageState(mergedState, nowMs).hasAccessToken, true);

const externalSource = await readFile(
  new URL("../rpa/spacecloud-external-reservation.mjs", import.meta.url),
  "utf8",
);
const detailSource = await readFile(
  new URL("../rpa/spacecloud-read-reservation-detail.mjs", import.meta.url),
  "utf8",
);
const loginSource = await readFile(
  new URL("../rpa/spacecloud-login.mjs", import.meta.url),
  "utf8",
);
const autoLoginSource = await readFile(
  new URL("../rpa/spacecloud-login-auto.mjs", import.meta.url),
  "utf8",
);
const sessionSource = await readFile(
  new URL("../rpa/lib/spacecloud-session.mjs", import.meta.url),
  "utf8",
);

for (const source of [externalSource, detailSource]) {
  assert.match(source, /ensureSpaceCloudAccessToken\(context\)/);
  assert.match(source, /checkpointSpaceCloudSession\(context,/);
  assert.match(source, /acquireSpaceCloudSessionUseLock/);
}
assert.match(externalSource, /Official retry succeeded after/);
assert.match(externalSource, /await throwIfSpaceCloudMutationFailed/);
for (const source of [loginSource, sessionSource]) {
  assert.match(source, /secureAuthFileForService/);
}
assert.match(autoLoginSource, /checkpointSpaceCloudSession\(context,/);
assert.match(autoLoginSource, /includePersistedState:\s*!controlledExpiredSessionTest/);
assert.match(autoLoginSource, /element\.click\(\)/);
assert.match(autoLoginSource, /SPACECLOUD_KAKAO_LOGIN_ID/);
assert.match(autoLoginSource, /SPACECLOUD_KAKAO_LOGIN_PASSWORD/);
assert.match(autoLoginSource, /await loginInput\.fill\(loginId\)/);
assert.match(autoLoginSource, /await passwordInput\.fill\(password\)/);
assert.match(autoLoginSource, /checkbox\.evaluate\(\(element\) => element\.click\(\)\)/);
assert.match(autoLoginSource, /return !domain\.includes\("spacecloud\.kr"\)/);
assert.match(autoLoginSource, /kind:\s*"authenticated"/);
assert.match(autoLoginSource, /kind:\s*"email-verification"/);
assert.match(autoLoginSource, /automatic-kakao-saved-login/);
assert.match(autoLoginSource, /submittedKakaoLoginPages = new WeakSet/);
assert.match(autoLoginSource, /accounts\\\.kakao\\\.com/);
assert.match(autoLoginSource, /getByRole\("button", \{ name: \/\^로그인\$\/ \}\)/);
assert.match(autoLoginSource, /authenticatedPartnerFromLiveState/);
assert.match(autoLoginSource, /if \(kakaoLoginStillOpen\) return null/);
assert.match(autoLoginSource, /diagnostic:\s*"kakao-login-rejected"/);
assert.match(autoLoginSource, /redacted-email/);

console.log("SpaceCloud session refresh tests passed.");
