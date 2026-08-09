import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_CREDENTIALS_PATH = "/srv/memoroom/shared/google-people-credentials.json";
const DEFAULT_TOKEN_PATH = "/srv/memoroom/shared/google-people-token.json";

function credentialsPath() {
  return process.env.GOOGLE_AUTOMATION_CREDENTIALS_PATH?.trim()
    || process.env.GOOGLE_PEOPLE_CREDENTIALS_PATH?.trim()
    || DEFAULT_CREDENTIALS_PATH;
}

function tokenPath() {
  return process.env.GOOGLE_AUTOMATION_TOKEN_PATH?.trim()
    || process.env.GOOGLE_PEOPLE_TOKEN_PATH?.trim()
    || DEFAULT_TOKEN_PATH;
}

function scopeSet(value) {
  return new Set(String(value || "").split(/\s+/).filter(Boolean));
}

async function writeTokenAtomically(filePath, token) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function getGoogleAccessToken({ requiredScopes = [] } = {}) {
  const resolvedCredentialsPath = credentialsPath();
  const resolvedTokenPath = tokenPath();
  const [credentials, storedToken] = await Promise.all([
    fs.readFile(resolvedCredentialsPath, "utf8").then(JSON.parse),
    fs.readFile(resolvedTokenPath, "utf8").then(JSON.parse),
  ]);

  const grantedScopes = scopeSet(storedToken.scope);
  const missingScopes = requiredScopes.filter((scope) => !grantedScopes.has(scope));
  if (missingScopes.length > 0) {
    throw new Error(
      `Google authorization must be renewed with the required scope: ${missingScopes.join(", ")}`,
    );
  }

  if (storedToken.access_token && Number(storedToken.expires_at || 0) > Date.now() + 60_000) {
    return storedToken.access_token;
  }

  if (!credentials.client_id || !credentials.client_secret || !storedToken.refresh_token) {
    throw new Error("Google OAuth credentials or refresh token is missing.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: storedToken.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new Error(
      payload?.error_description || payload?.error || `Google access token refresh failed (${response.status}).`,
    );
  }

  const updatedToken = {
    ...storedToken,
    access_token: payload.access_token,
    expires_at: Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000,
    token_type: payload.token_type || storedToken.token_type,
    scope: payload.scope || storedToken.scope,
    refreshed_at: new Date().toISOString(),
  };
  await writeTokenAtomically(resolvedTokenPath, updatedToken);
  return updatedToken.access_token;
}

