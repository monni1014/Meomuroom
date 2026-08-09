import { existsSync, readFileSync } from "node:fs";
import { optionalEnv } from "./lib/env.mjs";
import { launchRpaBrowser, newRpaContext } from "./lib/browser.mjs";
import { waitForLatestKakaoLoginCode } from "./lib/gmail-kakao-verification.mjs";
import { spaceCloudStorageStatePath } from "./lib/paths.mjs";
import {
  acquireSpaceCloudSessionUseLock,
  checkpointSpaceCloudSession,
  ensureSpaceCloudAccessToken,
  saveSpaceCloudSessionMeta,
  spaceCloudBrowserOptions,
} from "./lib/spacecloud-session.mjs";

const PARTNER_HOME = optionalEnv("SPACECLOUD_HOST_HOME_URL", "https://partner.spacecloud.kr/");
const PARTNER_RESERVATIONS = "https://partner.spacecloud.kr/reservation/";
const LOGIN_TIMEOUT_MS = 4 * 60 * 1000;
const controlledExpiredSessionTest = process.argv.includes("--test-expired-session");
const submittedKakaoLoginPages = new WeakSet();

function buildExpiredSpaceCloudTestState(filePath) {
  const state = JSON.parse(readFileSync(filePath, "utf8"));
  return {
    ...state,
    cookies: (state.cookies || []).filter((cookie) => {
      const domain = String(cookie?.domain || "").toLowerCase();
      return !domain.includes("spacecloud.kr");
    }),
    origins: (state.origins || []).filter((origin) => {
      const location = String(origin?.origin || "").toLowerCase();
      return !location.includes("spacecloud.kr");
    }),
  };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function loginRequired(error) {
  return /login required|refresh token is missing|refresh token was rejected|expired/i.test(errorText(error));
}

function partnerApiResponse(response) {
  if (!/^https:\/\/api\.spacecloud\.kr\/partner\//i.test(response.url())) return false;
  if (response.request().method() === "OPTIONS") return false;
  if (response.status() < 200 || response.status() >= 300) return false;
  return Boolean(response.request().headers().authorization);
}

async function verifyPartnerAccess(page) {
  const responsePromise = page.waitForResponse(partnerApiResponse, { timeout: 60_000 });
  await page.goto(PARTNER_RESERVATIONS, { timeout: 60_000, waitUntil: "domcontentloaded" });
  await responsePromise;
}

function openPages(context) {
  return context.pages().filter((page) => !page.isClosed()).reverse();
}

async function logControlledTestPageState(context) {
  if (!controlledExpiredSessionTest) return;
  for (const page of openPages(context)) {
    const location = (() => {
      try {
        const url = new URL(page.url());
        return `${url.origin}${url.pathname}`;
      } catch {
        return "unknown";
      }
    })();
    const controls = await page.locator("button, a, label").evaluateAll((elements) => (
      elements
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        })
        .map((element) => String(element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 30)
    )).catch(() => []);
    const inputs = await page.locator("input").evaluateAll((elements) => (
      elements.slice(0, 20).map((element) => ({
        type: element.type,
        name: element.name,
        checked: element.type === "checkbox" ? element.checked : undefined,
      }))
    )).catch(() => []);
    console.log(JSON.stringify({ diagnostic: "kakao-login-step", location, controls, inputs }));
  }
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

async function findTextTarget(context, pattern) {
  for (const page of openPages(context)) {
    const candidates = [
      page.getByRole("button", { name: pattern }).first(),
      page.getByRole("link", { name: pattern }).first(),
      page.getByText(pattern, { exact: false }).first(),
    ];
    for (const candidate of candidates) {
      if (await visible(candidate)) return { page, locator: candidate };
    }
  }
  return null;
}

async function waitForTextTarget(context, pattern, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = await findTextTarget(context, pattern);
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`SpaceCloud automatic login could not find the expected step: ${pattern}`);
}

async function clickTarget(locator, timeoutMs = 10_000) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 3_000 });
    await locator.click({ timeout: timeoutMs });
  } catch (error) {
    if (!/outside of the viewport|timeout/i.test(errorText(error))) throw error;
    await locator.evaluate((element) => element.click());
  }
}

async function clickText(context, pattern, timeoutMs = 30_000) {
  const target = await waitForTextTarget(context, pattern, timeoutMs);
  await clickTarget(target.locator);
  await target.page.waitForTimeout(700);
  return target.page;
}

function sanitizedDiagnosticText(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b\d{7,}\b/g, "[redacted-number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function kakaoLoginCredentials() {
  const loginId = process.env.SPACECLOUD_KAKAO_LOGIN_ID?.trim();
  const password = process.env.SPACECLOUD_KAKAO_LOGIN_PASSWORD;
  if (!loginId || !password) {
    throw new Error(
      "Kakao login credentials are unavailable in the protected server environment.",
    );
  }
  return { loginId, password };
}

async function fillKakaoLoginForm(page) {
  if (!/^https:\/\/accounts\.kakao\.com\/login\//i.test(page.url())) return false;
  const passwordInput = page.locator('input[type="password"]:visible').first();
  if (!(await visible(passwordInput))) return false;
  if (submittedKakaoLoginPages.has(page)) return true;

  const loginInput = page.locator([
    'input[name="loginKey"]:visible',
    'input[autocomplete="username"]:visible',
    'input[type="email"]:visible',
    'input[type="text"]:visible',
  ].join(", ")).first();
  if (!(await visible(loginInput))) {
    throw new Error("Kakao login identifier input did not appear.");
  }

  const { loginId, password } = kakaoLoginCredentials();
  await loginInput.fill(loginId);
  await passwordInput.fill(password);

  const checkbox = page.locator('input[type="checkbox"]:visible').first();
  if (await visible(checkbox) && !(await checkbox.isChecked().catch(() => false))) {
    await checkbox.evaluate((element) => element.click());
  }

  const loginButton = page.getByRole("button", { name: /^로그인$/ }).first();
  if (!(await visible(loginButton))) {
    throw new Error("Kakao login submit button did not appear.");
  }
  submittedKakaoLoginPages.add(page);
  await clickTarget(loginButton);
  await page.waitForTimeout(2_000);
  if (/^https:\/\/accounts\.kakao\.com\/login\//i.test(page.url()) && await visible(passwordInput)) {
    if (controlledExpiredSessionTest) {
      const pageText = await page.locator("body").innerText().catch(() => "");
      console.log(JSON.stringify({
        diagnostic: "kakao-login-rejected",
        message: sanitizedDiagnosticText(pageText),
      }));
    }
    throw new Error("Kakao login did not advance to the email-authentication step.");
  }
  return true;
}

async function authenticatedPartnerFromLiveState(context) {
  const kakaoLoginStillOpen = openPages(context).some((page) => (
    /^https:\/\/accounts\.kakao\.com\/login\//i.test(page.url())
  ));
  if (kakaoLoginStillOpen) return null;

  try {
    await ensureSpaceCloudAccessToken(context, {
      refreshBeforeMs: 0,
      includePersistedState: !controlledExpiredSessionTest,
    });
    return openPages(context).find((page) => (
      /^https:\/\/partner\.spacecloud\.kr\//i.test(page.url())
    )) || null;
  } catch {
    return null;
  }
}

async function waitForKakaoEmailAuthentication(context, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of openPages(context)) {
      if (!/^https:\/\/partner\.spacecloud\.kr\//i.test(page.url())) continue;
      const logout = page.getByText(/호스트\s*로그아웃/).first();
      if (await visible(logout)) return { kind: "authenticated", page };
    }

    for (const page of openPages(context)) {
      await fillKakaoLoginForm(page);
    }

    const authenticatedPage = await authenticatedPartnerFromLiveState(context);
    if (authenticatedPage) return { kind: "authenticated", page: authenticatedPage };

    const saveLabel = await findTextTarget(context, /간편로그인\s*정보\s*저장/);
    if (saveLabel) {
      const checkbox = saveLabel.page.locator('input[type="checkbox"]:visible').first();
      if (await visible(checkbox) && !(await checkbox.isChecked().catch(() => false))) {
        await checkbox.check().catch(() => saveLabel.locator.click());
      }
    }

    const emailAuthentication = await findTextTarget(context, /이메일로\s*인증하기/);
    if (emailAuthentication) return { kind: "email-verification", ...emailAuthentication };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await logControlledTestPageState(context);
  throw new Error("SpaceCloud automatic login could not reach Kakao email authentication.");
}

async function fillVerificationCode(context, code) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const page of openPages(context)) {
      const named = page.locator(
        'input[placeholder*="인증번호"]:visible, input[aria-label*="인증번호"]:visible, input[name*="cert"]:visible, input[name*="code"]:visible',
      ).first();
      if (await visible(named)) {
        await named.fill(code);
        return page;
      }

      const digitInputs = page.locator(
        'input:visible:not([type="password"]):not([type="email"]):not([type="checkbox"]):not([type="hidden"])',
      );
      const count = await digitInputs.count();
      if (count === code.length) {
        for (let index = 0; index < code.length; index += 1) {
          await digitInputs.nth(index).fill(code[index]);
        }
        return page;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Kakao verification-code input did not appear.");
}

async function submitVerification(context, page) {
  const patterns = [/인증\s*확인/, /^확인$/, /^로그인$/];
  for (const pattern of patterns) {
    const target = await findTextTarget(context, pattern);
    if (target) {
      await clickTarget(target.locator);
      return;
    }
  }
  await page.keyboard.press("Enter");
}

async function waitForAuthenticatedPartner(context, timeoutMs = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await ensureSpaceCloudAccessToken(context, {
        refreshBeforeMs: 0,
        includePersistedState: !controlledExpiredSessionTest,
      });
      let partnerPage = openPages(context).find((page) => (
        /^https:\/\/partner\.spacecloud\.kr\//i.test(page.url())
      ));
      if (!partnerPage) partnerPage = await context.newPage();
      await verifyPartnerAccess(partnerPage);
      return partnerPage;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(
    `SpaceCloud Kakao verification completed, but the host session was not restored: ${errorText(lastError)}`,
  );
}

async function runInteractiveRelogin(context) {
  let page = openPages(context)[0] || await context.newPage();
  await page.goto(PARTNER_HOME, { timeout: 60_000, waitUntil: "domcontentloaded" });

  const hostLogin = await findTextTarget(context, /카카오로\s*호스트\s*로그인/);
  if (!hostLogin) await clickText(context, /^로그인$/, 20_000);
  await clickText(context, /카카오로\s*호스트\s*로그인/, 30_000);
  const loginStep = await waitForKakaoEmailAuthentication(context);

  if (loginStep.kind === "authenticated") {
    await waitForAuthenticatedPartner(context);
    await checkpointSpaceCloudSession(context, "automatic-kakao-saved-login");
    saveSpaceCloudSessionMeta({ useProxy: spaceCloudBrowserOptions(true).useProxy });
    return;
  }

  const requestedAtMs = Date.now();
  await clickTarget(loginStep.locator);
  const { code } = await waitForLatestKakaoLoginCode({ requestedAtMs });
  page = await fillVerificationCode(context, code);
  await submitVerification(context, page);

  await waitForAuthenticatedPartner(context);
  await checkpointSpaceCloudSession(context, "automatic-kakao-email-relogin");
  saveSpaceCloudSessionMeta({ useProxy: spaceCloudBrowserOptions(true).useProxy });
}

async function main() {
  const releaseLock = await acquireSpaceCloudSessionUseLock("SpaceCloud automatic login");
  const browserOptions = { ...spaceCloudBrowserOptions(true), reuse: false };
  let browser = null;
  try {
    browser = await launchRpaBrowser(browserOptions);
    const initialStorageState = controlledExpiredSessionTest
      ? buildExpiredSpaceCloudTestState(spaceCloudStorageStatePath)
      : (existsSync(spaceCloudStorageStatePath) ? spaceCloudStorageStatePath : null);
    const context = await newRpaContext(browser, {
      ...(initialStorageState ? { storageState: initialStorageState } : {}),
      blockHeavyResources: false,
      rpaRole: "spacecloud",
    });
    const page = await context.newPage();

    try {
      await ensureSpaceCloudAccessToken(context, {
        includePersistedState: !controlledExpiredSessionTest,
      });
      await verifyPartnerAccess(page);
      await checkpointSpaceCloudSession(context, "automatic-login-health-check");
      console.log(JSON.stringify({ ok: true, action: "session-valid" }));
      return;
    } catch (error) {
      if (!loginRequired(error)) throw error;
    }

    await runInteractiveRelogin(context);
    console.log(JSON.stringify({
      ok: true,
      action: controlledExpiredSessionTest ? "automatic-relogin-test" : "automatic-relogin",
    }));
  } finally {
    await browser?.close().catch(() => {});
    await releaseLock();
  }
}

main().catch((error) => {
  console.error(`SpaceCloud automatic login failed: ${errorText(error)}`);
  process.exitCode = 1;
});
