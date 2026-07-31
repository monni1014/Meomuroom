import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseArgs, requiredArg } from "./lib/cli.mjs";
import { assertRpaExecutionAllowed, getUpstreamProxyUrl } from "./lib/env.mjs";
import {
  monthsInRange,
  parseSynergySpacecloudAvailability,
} from "./lib/synergy-spacecloud-availability.mjs";

const RESULT_PREFIX = "__COMPETITOR_SCAN_RESULT__";
const PRODUCT_ID = 93383;
const RESERVATION_TYPE_ID = 165602;

function readJson(url, agent) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      agent,
      headers: {
        Accept: "application/json",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Memoroom read-only availability monitor",
      },
      timeout: 20_000,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`SpaceCloud availability API returned ${response.statusCode || 0}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`SpaceCloud availability API returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("SpaceCloud availability API timed out")));
    request.on("error", reject);
  });
}

function monthRange(year, month, startKey, endKey) {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { startKey: first < startKey ? startKey : first, endKey: last > endKey ? endKey : last };
}

async function main() {
  assertRpaExecutionAllowed();
  const args = parseArgs(process.argv);
  const startKey = requiredArg(args, "start");
  const endKey = requiredArg(args, "end");
  const checkedAt = new Date();
  const agent = new HttpsProxyAgent(getUpstreamProxyUrl());
  const observations = [];
  const errors = [];

  for (const { year, month } of monthsInRange(startKey, endKey)) {
    const url = new URL(`https://api.spacecloud.kr/products/${PRODUCT_ID}/prices`);
    url.searchParams.set("reservation_type_id", String(RESERVATION_TYPE_ID));
    url.searchParams.set("year", String(year));
    url.searchParams.set("month", String(month));
    const range = monthRange(year, month, startKey, endKey);
    try {
      const payload = await readJson(url, agent);
      observations.push(...parseSynergySpacecloudAvailability(payload, {
        ...range,
        checkedAt,
      }));
    } catch (error) {
      errors.push({
        competitorId: "synergy-spacecloud",
        dateKey: null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(RESULT_PREFIX + JSON.stringify({
    startKey,
    endKey,
    observations,
    evidence: [],
    errors,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
