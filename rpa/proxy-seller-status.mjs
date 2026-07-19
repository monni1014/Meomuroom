import { requiredEnv } from "./lib/env.mjs";

function maskedIp(ip) {
  const parts = String(ip || "").split(".");
  if (parts.length !== 4) return "-";
  return `${parts[0]}.${parts[1]}.x.x`;
}

async function main() {
  const apiKey = requiredEnv("PROXYSELLER_API_KEY");
  const url = `https://proxy-seller.com/personal/api/v1/${encodeURIComponent(apiKey)}/proxy/list/isp?latest=Y`;
  const response = await fetch(url, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Proxy-Seller API returned HTTP ${response.status}`);

  const payload = await response.json();
  if (payload?.status !== "success") {
    const message = payload?.errors?.map((error) => error.message).filter(Boolean).join(", ");
    throw new Error(message || "Proxy-Seller API returned an error");
  }

  const items = payload?.data?.items || [];
  if (items.length === 0) {
    console.log("No active ISP proxy was returned.");
    return;
  }

  console.log("=== Proxy-Seller ISP status ===");
  for (const item of items) {
    console.log(`IP         : ${maskedIp(item.ip_only || item.ip)}`);
    console.log(`Country    : ${item.country || item.country_alpha3 || "-"}`);
    console.log(`Status     : ${item.status || item.status_type || "-"}`);
    console.log(`Expires    : ${item.date_end || "-"}`);
    console.log(`Auto renew : ${item.auto_renew === "Y" ? `on (${item.auto_renew_period || "period unknown"})` : "off"}`);
    console.log("");
  }
}

main().catch((error) => {
  console.error("Proxy-Seller status failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
