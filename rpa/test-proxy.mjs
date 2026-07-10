import { launchRpaBrowser } from "./lib/browser.mjs";
import { optionalEnv, requiredEnv } from "./lib/env.mjs";

async function main() {
  const proxyHost = requiredEnv("IPROYAL_PROXY_HOST");
  const proxyPort = requiredEnv("IPROYAL_PROXY_PORT");
  const proxyProtocol = optionalEnv("IPROYAL_PROXY_PROTOCOL", "http");
  const headless = optionalEnv("RPA_HEADLESS", "false") !== "false";

  console.log(`Testing proxy: ${proxyProtocol}://${proxyHost}:${proxyPort}`);
  console.log(`Headless: ${headless ? "yes" : "no"}`);

  const browser = await launchRpaBrowser({ headless, forceProxy: true });

  try {
    const page = await browser.newPage();
    await page.goto("https://ipinfo.io/json", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });

    const raw = (await page.textContent("body")) || "{}";
    const info = JSON.parse(raw);

    console.log("\n=== Current outbound IP ===");
    console.log("IP      :", info.ip || "-");
    console.log("Country :", info.country || "-");
    console.log("Region  :", [info.city, info.region].filter(Boolean).join(", ") || "-");
    console.log("ISP     :", info.org || "-");

    if (info.country === "KR") {
      console.log("\nPASS: Proxy is using a Korea IP.");
    } else {
      console.log("\nCHECK: Proxy is not using a Korea IP. Check IPRoyal country settings.");
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Proxy test failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
