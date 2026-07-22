import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";

function argument(name, fallback = "") {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const credentialsPath = argument(
  "credentials",
  process.env.GOOGLE_PEOPLE_CREDENTIALS_PATH || "/srv/memoroom/shared/google-people-credentials.json",
);
const tokenPath = argument(
  "token",
  process.env.GOOGLE_PEOPLE_TOKEN_PATH || "/srv/memoroom/shared/google-people-token.json",
);
const urlFile = argument("url-file");
const port = Number(argument("port", "53682"));
const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
const state = crypto.randomBytes(32).toString("hex");
const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8"));

if (!credentials.client_id || !credentials.client_secret) {
  throw new Error("Google OAuth client_id/client_secret is missing.");
}

const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorizationUrl.search = new URLSearchParams({
  client_id: credentials.client_id,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "openid email https://www.googleapis.com/auth/contacts",
  access_type: "offline",
  prompt: "consent select_account",
  state,
}).toString();

if (urlFile) {
  await fs.mkdir(path.dirname(urlFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(urlFile, `${authorizationUrl.toString()}\n`, { mode: 0o600 });
}

console.log(JSON.stringify({ authorizationUrl: authorizationUrl.toString(), redirectUri }));

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", redirectUri);
  if (requestUrl.pathname !== "/oauth2/callback") {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    if (requestUrl.searchParams.get("state") !== state) throw new Error("OAuth state mismatch.");
    const oauthError = requestUrl.searchParams.get("error");
    if (oauthError) throw new Error(`Google authorization failed: ${oauthError}`);
    const code = requestUrl.searchParams.get("code");
    if (!code) throw new Error("Authorization code is missing.");

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token || !token.refresh_token) {
      throw new Error(token.error_description || token.error || `Token exchange failed (${tokenResponse.status})`);
    }

    const userInfoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const userInfo = await userInfoResponse.json();
    if (!userInfoResponse.ok || !userInfo.email) {
      throw new Error(userInfo.error_description || userInfo.error || "Google account email could not be verified.");
    }

    const storedToken = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + Math.max(60, token.expires_in || 3600) * 1000,
      token_type: token.token_type,
      scope: token.scope,
      email: userInfo.email,
      connected_at: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${tokenPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(storedToken, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, tokenPath);
    await fs.chmod(tokenPath, 0o600);

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><meta charset=utf-8><title>머무룸 연락처 연결 완료</title><style>body{font-family:sans-serif;padding:48px;line-height:1.7}</style><h1>연결 완료</h1><p>와이프 Google 계정 연락처 연결이 완료되었습니다. 이 창을 닫아도 됩니다.</p>");
    console.log(JSON.stringify({ connected: true, email: userInfo.email }));
  } catch (error) {
    response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><meta charset=utf-8><h1>연결 실패</h1><p>머무룸 설정에서 다시 연결해주세요.</p>");
    console.error(error instanceof Error ? error.message : error);
  } finally {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ listening: true, port }));
});

setTimeout(() => {
  console.error("Google authorization timed out.");
  server.close();
  process.exitCode = 1;
}, 10 * 60 * 1000).unref();
