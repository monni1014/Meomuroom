import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getGoogleAccessToken } from "./google-oauth.mjs";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const KAKAO_LOGIN_MAIL = Object.freeze({
  from: "noreply@kakaocorp.com",
  subject: "[\uCE74\uCE74\uC624\uACC4\uC815] \uB85C\uADF8\uC778 \uC778\uC99D\uBC88\uD638",
});

const DEFAULT_STATE_PATH = "/srv/memoroom/shared/spacecloud-kakao-mail-state.json";

function statePath() {
  return process.env.SPACECLOUD_KAKAO_MAIL_STATE_PATH?.trim() || DEFAULT_STATE_PATH;
}

function decodeBase64Url(value) {
  if (!value) return "";
  return Buffer.from(value, "base64url").toString("utf8");
}

function collectMimeText(part, output = []) {
  const mimeType = String(part?.mimeType || "").toLowerCase();
  if ((mimeType === "text/plain" || mimeType === "text/html") && part?.body?.data) {
    output.push(decodeBase64Url(part.body.data));
  }
  for (const child of part?.parts || []) collectMimeText(child, output);
  return output;
}

function headerValue(message, name) {
  return message?.payload?.headers?.find(
    (header) => String(header.name || "").toLowerCase() === name.toLowerCase(),
  )?.value || "";
}

export function extractEmailAddress(value) {
  const bracketed = /<([^>]+)>/.exec(String(value || ""));
  const candidate = bracketed?.[1] || String(value || "");
  return candidate.trim().toLowerCase();
}

export function extractKakaoLoginCode(message) {
  const content = [message?.snippet || "", ...collectMimeText(message?.payload)]
    .join("\n")
    .replace(/&nbsp;|&#160;/gi, " ");
  const candidates = [...content.matchAll(/(?<!\d)(\d{8})(?!\d)/g)].map((match) => match[1]);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) {
    throw new Error(`Kakao verification email contained ${unique.length} distinct 8-digit code candidates.`);
  }
  const contextual = /\uB85C\uADF8\uC778\uC744\s*\uC704\uD55C\s*\uC778\uC99D\uBC88\uD638(?:\uC785\uB2C8\uB2E4)?[\s\S]{0,200}?(\d{8})(?!\d)/i.exec(content);
  if (!contextual || contextual[1] !== unique[0]) {
    throw new Error("Kakao verification email did not contain the expected login-code wording.");
  }
  return contextual[1];
}

export function isExactKakaoLoginMessage(message, requestedAtMs) {
  const sender = extractEmailAddress(headerValue(message, "From"));
  const subject = headerValue(message, "Subject").trim();
  const internalDate = Number(message?.internalDate || 0);
  return sender === KAKAO_LOGIN_MAIL.from
    && subject === KAKAO_LOGIN_MAIL.subject
    && internalDate >= requestedAtMs;
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

async function readState() {
  try {
    const value = JSON.parse(await fs.readFile(statePath(), "utf8"));
    return { usedMessageIds: Array.isArray(value?.usedMessageIds) ? value.usedMessageIds : [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { usedMessageIds: [] };
    throw error;
  }
}

async function rememberMessageId(messageId) {
  const filePath = statePath();
  const current = await readState();
  const usedMessageIds = [...new Set([messageId, ...current.usedMessageIds])].slice(0, 100);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify({
    usedMessageIds,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForLatestKakaoLoginCode({ requestedAtMs, timeoutMs = 120_000, pollIntervalMs = 2_000 } = {}) {
  if (!Number.isFinite(requestedAtMs)) throw new Error("Kakao verification request time is missing.");
  const accessToken = await getGoogleAccessToken({ requiredScopes: [GMAIL_READONLY_SCOPE] });
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = await readState();
    const listing = await gmailRequest(accessToken, "messages", {
      // Gmail's search parser can mis-handle bracketed non-ASCII subjects.
      // Narrow by the exact sender and request time here, then enforce exact
      // From/Subject equality on the fetched message headers below.
      q: `from:${KAKAO_LOGIN_MAIL.from} after:${Math.floor(requestedAtMs / 1000)}`,
      maxResults: 10,
    });

    const candidates = [];
    for (const item of listing.messages || []) {
      if (!item?.id || state.usedMessageIds.includes(item.id)) continue;
      const message = await gmailRequest(accessToken, `messages/${encodeURIComponent(item.id)}`, { format: "full" });
      if (!isExactKakaoLoginMessage(message, requestedAtMs)) continue;
      candidates.push(message);
    }

    candidates.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));
    if (candidates.length > 0) {
      const selected = candidates[0];
      const code = extractKakaoLoginCode(selected);
      await rememberMessageId(selected.id);
      return { code, messageId: selected.id, receivedAt: new Date(Number(selected.internalDate)).toISOString() };
    }
    await sleep(pollIntervalMs);
  }
  throw new Error("A matching Kakao login verification email did not arrive before timeout.");
}
