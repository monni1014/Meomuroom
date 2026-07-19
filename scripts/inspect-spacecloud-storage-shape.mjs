import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spaceCloudStorageStatePath } from "../rpa/lib/paths.mjs";

function valueShape(value, depth = 0) {
  if (depth >= 4) return Array.isArray(value) ? "array" : typeof value;
  if (value === null) return "null";
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => valueShape(item, depth + 1));
  if (typeof value !== "object") return typeof value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, valueShape(item, depth + 1)]),
  );
}

function accessTokenMetadata(state) {
  const entry = (state.origins || [])
    .find((origin) => origin.origin === "https://partner.spacecloud.kr")
    ?.localStorage?.find((item) => item.name === "spacecloud__userInfo");
  if (!entry) return { present: false };

  try {
    const accessToken = JSON.parse(entry.value)?.accessToken;
    if (typeof accessToken !== "string" || !accessToken) return { present: false };
    const parts = accessToken.split(".");
    if (parts.length !== 3) return { present: true, format: "opaque", length: accessToken.length };
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    return {
      present: true,
      format: "jwt",
      issuedAt: Number.isFinite(payload.iat) ? new Date(payload.iat * 1000).toISOString() : null,
      expiresAt: Number.isFinite(payload.exp) ? new Date(payload.exp * 1000).toISOString() : null,
      expired: Number.isFinite(payload.exp) ? payload.exp <= now : null,
      partnerFingerprint: payload.partner_id
        ? createHash("sha256").update(String(payload.partner_id)).digest("hex").slice(0, 12)
        : null,
      claimNames: Object.keys(payload).sort(),
    };
  } catch {
    return { present: true, format: "unreadable" };
  }
}

const state = JSON.parse(readFileSync(spaceCloudStorageStatePath, "utf8"));
console.log(JSON.stringify({
  accessToken: accessTokenMetadata(state),
  cookies: (state.cookies || []).map((cookie) => ({
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    expires: cookie.expires,
  })),
  origins: (state.origins || []).map((origin) => ({
    origin: origin.origin,
    localStorage: (origin.localStorage || []).map((entry) => {
      let shape = "string";
      try {
        shape = valueShape(JSON.parse(entry.value));
      } catch {
        // Keep non-JSON values redacted.
      }
      return { name: entry.name, shape };
    }),
    indexedDB: (origin.indexedDB || []).map((database) => ({
      name: database.name,
      stores: (database.stores || []).map((store) => store.name),
    })),
  })),
}, null, 2));
