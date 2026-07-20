import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const apiBase = "https://api.solapi.com";
const targetUrl = process.argv[2];
const apiKey = process.env.SOLAPI_API_KEY?.trim();
const apiSecret = process.env.SOLAPI_API_SECRET?.trim();
const webhookSecret = process.env.SOLAPI_WEBHOOK_SECRET?.trim();

if (!targetUrl?.startsWith("https://")) throw new Error("Pass the public HTTPS webhook URL.");
if (!apiKey || !apiSecret || !webhookSecret) throw new Error("Solapi API and webhook secrets are required.");

function authorization() {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto.createHmac("sha256", apiSecret).update(date + salt).digest("hex");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: authorization(),
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Solapi webhook API failed (${response.status}): ${text.slice(0, 300)}`);
  return payload;
}

const listed = await request("/webhook/v1/outgoing");
const hooks = Array.isArray(listed)
  ? listed
  : listed?.webhooks || listed?.outgoing || listed?.items || listed?.data || [];
const existing = Array.isArray(hooks)
  ? hooks.find((hook) => hook?.eventId === "SINGLE-REPORT")
  : null;

let registered;
if (existing?.webhookId) {
  registered = await request(`/webhook/v1/outgoing/${existing.webhookId}`, {
    method: "PUT",
    body: JSON.stringify({ url: targetUrl, secret: webhookSecret, status: "ACTIVE" }),
  });
} else {
  registered = await request("/webhook/v1/outgoing", {
    method: "POST",
    body: JSON.stringify({ eventId: "SINGLE-REPORT", url: targetUrl, secret: webhookSecret }),
  });
}

console.log(JSON.stringify({
  webhookId: registered?.webhookId || existing?.webhookId || null,
  eventId: registered?.eventId || "SINGLE-REPORT",
  url: registered?.url || targetUrl,
  status: registered?.status || "ACTIVE",
}, null, 2));
