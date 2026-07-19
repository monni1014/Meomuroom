import { readFileSync } from "node:fs";
import { request } from "playwright";
import {
  assertRpaExecutionAllowed,
  getProxyConfig,
} from "../rpa/lib/env.mjs";
import { spaceCloudStorageStatePath } from "../rpa/lib/paths.mjs";
import { shouldUseSpaceCloudProxy } from "../rpa/lib/spacecloud-session.mjs";

assertRpaExecutionAllowed();

function readAccessToken() {
  const state = JSON.parse(readFileSync(spaceCloudStorageStatePath, "utf8"));
  const entry = (state.origins || [])
    .find((origin) => origin.origin === "https://partner.spacecloud.kr")
    ?.localStorage?.find((item) => item.name === "spacecloud__userInfo");
  const token = entry ? JSON.parse(entry.value)?.accessToken : null;
  if (typeof token !== "string" || !token) throw new Error("SpaceCloud access token is missing.");
  return token;
}

const useProxy = shouldUseSpaceCloudProxy();
const proxy = useProxy ? getProxyConfig() : null;
const accessToken = readAccessToken();
const client = await request.newContext({
  timeout: 60_000,
  ...(proxy ? { proxy } : {}),
  extraHTTPHeaders: {
    Accept: "application/json, text/plain, */*",
    Origin: "https://partner.spacecloud.kr",
    Referer: "https://partner.spacecloud.kr/",
  },
});

try {
  const results = [];
  for (const [authorizationMode, authorization] of [
    ["raw", accessToken],
    ["bearer", `Bearer ${accessToken}`],
  ]) {
    try {
      const response = await client.post(
        "https://api.spacecloud.kr/partner/products/120701/external_schedules",
        {
          failOnStatusCode: false,
          headers: { Authorization: authorization },
          data: {},
        },
      );
      results.push({ authorizationMode, status: response.status() });
    } catch (error) {
      results.push({
        authorizationMode,
        status: null,
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify({
    network: useProxy ? "proxy" : "direct",
    target: "memoroom-product-with-empty-invalid-body",
    mutationPossible: false,
    results,
  }, null, 2));
} finally {
  await client.dispose();
}
