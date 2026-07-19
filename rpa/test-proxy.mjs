import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { getProxyConfig, optionalEnv } from "./lib/env.mjs";

const ACCESS_CHECKS = [
  { name: "Naver login", url: "https://nid.naver.com/nidlogin.login" },
  { name: "Kakao login", url: "https://accounts.kakao.com/login" },
  { name: "SpaceCloud host", url: "https://partner.spacecloud.kr/" },
];

const BLOCK_MARKERS = [
  /captcha/i,
  /access denied/i,
  /temporarily blocked/i,
  /비정상적인 접근/,
  /접근이 제한/,
  /자동입력 방지/,
];

async function readJson(page, url) {
  await page.setExtraHTTPHeaders({
    Accept: "application/json",
    "Save-Data": "on",
  });
  const response = await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
  if (!response) throw new Error(`No HTTP response from ${url}`);
  return response.json();
}

async function checkAccess(page, check) {
  const startedAt = Date.now();
  const response = await page.goto(check.url, {
    timeout: 30_000,
    waitUntil: "domcontentloaded",
  });
  const body = ((await page.textContent("body").catch(() => "")) || "").slice(0, 20_000);
  const blocked = BLOCK_MARKERS.some((pattern) => pattern.test(body) || pattern.test(page.url()));
  const status = response?.status() || 0;
  const reachable = status >= 200 && status < 500 && !blocked;

  return {
    name: check.name,
    reachable,
    status,
    elapsedMs: Date.now() - startedAt,
    finalUrl: page.url(),
    blocked,
  };
}

async function main() {
  const proxy = getProxyConfig();
  const headless = optionalEnv("RPA_HEADLESS", "false") !== "false";

  console.log(`Testing proxy provider: ${proxy.provider}`);
  console.log(`Proxy endpoint: ${proxy.protocol}://${proxy.host}:${proxy.port}`);
  console.log(`Headless: ${headless ? "yes" : "no"}`);

  const browser = await launchRpaBrowser({ headless, forceProxy: true });

  try {
    const context = await newRpaContext(browser, {
      blockHeavyResources: true,
      reusePage: false,
    });
    const page = await context.newPage();

    const ipInfo = await readJson(page, "https://ipinfo.io/json");
    const ipify = await readJson(page, "https://api.ipify.org?format=json");
    await page.setExtraHTTPHeaders({ "Save-Data": "on" });
    const firstIp = ipInfo.ip || "";
    const secondIp = ipify.ip || "";
    const country = ipInfo.country || "";

    console.log("\n=== Current outbound IP ===");
    console.log("IP      :", firstIp || secondIp || "-");
    console.log("Country :", country || "-");
    console.log(
      "Region  :",
      [ipInfo.city, ipInfo.region].filter(Boolean).join(", ") || "-",
    );
    console.log("ISP     :", ipInfo.org || "-");
    console.log("ASN     :", String(ipInfo.org || "").split(" ")[0] || "-");

    let failed = false;
    if (!firstIp || !secondIp || firstIp !== secondIp) {
      failed = true;
      console.log("CHECK  : IP lookup services returned different or missing addresses.");
    }
    if (country !== "KR") {
      failed = true;
      console.log("CHECK  : The proxy is not classified as a Korea IP.");
    }

    console.log("\n=== Site access ===");
    for (const check of ACCESS_CHECKS) {
      try {
        const result = await checkAccess(page, check);
        const label = result.reachable ? "PASS" : "CHECK";
        console.log(
          `${label.padEnd(5)} ${result.name.padEnd(16)} ${String(result.status).padEnd(3)} ${result.elapsedMs}ms`,
        );
        if (!result.reachable) failed = true;
      } catch (error) {
        failed = true;
        console.log(
          `CHECK ${check.name.padEnd(16)} ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (failed) {
      throw new Error("Proxy checks require review. Do not use this IP for account login yet.");
    }

    console.log("\nPASS: Korea IP and non-login access checks passed.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Proxy test failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
