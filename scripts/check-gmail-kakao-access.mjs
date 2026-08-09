import { getGoogleAccessToken } from "../rpa/lib/google-oauth.mjs";
import {
  GMAIL_READONLY_SCOPE,
  KAKAO_LOGIN_MAIL,
  extractEmailAddress,
} from "../rpa/lib/gmail-kakao-verification.mjs";

function headerValue(message, name) {
  return message?.payload?.headers?.find(
    (header) => String(header.name || "").toLowerCase() === name.toLowerCase(),
  )?.value || "";
}

async function gmailRequest(accessToken, pathname, searchParams = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${pathname}`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gmail API request failed (${response.status}).`);
  }
  return payload;
}

const accessToken = await getGoogleAccessToken({ requiredScopes: [GMAIL_READONLY_SCOPE] });
const listing = await gmailRequest(accessToken, "messages", {
  q: `from:${KAKAO_LOGIN_MAIL.from}`,
  maxResults: 20,
});

let latestReceivedAt = null;
let exactMatchCount = 0;
for (const item of listing.messages || []) {
  if (!item?.id) continue;
  const message = await gmailRequest(accessToken, `messages/${encodeURIComponent(item.id)}`, {
    format: "metadata",
    metadataHeaders: ["From", "Subject"],
  });
  const sender = extractEmailAddress(headerValue(message, "From"));
  const subject = headerValue(message, "Subject").trim();
  if (sender !== KAKAO_LOGIN_MAIL.from || subject !== KAKAO_LOGIN_MAIL.subject) continue;
  exactMatchCount += 1;
  const receivedAt = Number(message.internalDate || 0);
  if (receivedAt > 0 && (!latestReceivedAt || receivedAt > Date.parse(latestReceivedAt))) {
    latestReceivedAt = new Date(receivedAt).toISOString();
  }
}

console.log(JSON.stringify({
  ok: true,
  sender: KAKAO_LOGIN_MAIL.from,
  subject: KAKAO_LOGIN_MAIL.subject,
  exactMatchCount,
  latestReceivedAt,
}));
