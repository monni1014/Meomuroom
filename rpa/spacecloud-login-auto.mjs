import { existsSync } from "node:fs";
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

async function clickText(context, pattern, timeoutMs = 30_000) {
  const target = await waitForTextTarget(context, pattern, timeoutMs);
  await target.locator.click({ timeout: 10_000 });
  await target.page.waitForTimeout(700);
  return target.page;
}

async function waitForKakaoEmailAuthentication(context, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of openPages(context)) {
      const passwordInput = page.locator('input[type="password"]:visible').first();
      if (await visible(passwordInput)) {
        throw new Error(
          "Kakao saved login is unavailable. Manual Kakao login is required once; credentials are never stored by Memoroom.",
        );
      }
    }

    const saveLabel = await findTextTarget(context, /간편로그인\s*정보\s*저장/);
    if (saveLabel) {
      const checkbox = saveLabel.page.locator('input[type="checkbox"]:visible').first();
      if (await visible(checkbox) && !(await checkbox.isChecked().catch(() => false))) {
        await checkbox.check().catch(() => saveLabel.locator.click());
      }
    }

    const emailAuthentication = await findTextTarget(context, /이메일로\s*인증하기/);
    if (emailAuthentication) return emailAuthentication;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
      await target.locator.click({ timeout: 10_000 });
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
      await ensureSpaceCloudAccessToken(context, { refreshBeforeMs: 0 });
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
  const emailAuthentication = await waitForKakaoEmailAuthentication(context);

  const requestedAtMs = Date.now();
  await emailAuthentication.locator.click({ timeout: 10_000 });
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
    const context = await newRpaContext(browser, {
      ...(existsSync(spaceCloudStorageStatePath) ? { storageState: spaceCloudStorageStatePath } : {}),
      blockHeavyResources: false,
      rpaRole: "spacecloud",
    });
    const page = await context.newPage();

    try {
      await ensureSpaceCloudAccessToken(context);
      await verifyPartnerAccess(page);
      await checkpointSpaceCloudSession(context, "automatic-login-health-check");
      console.log(JSON.stringify({ ok: true, action: "session-valid" }));
      return;
    } catch (error) {
      if (!loginRequired(error)) throw error;
    }

    await runInteractiveRelogin(context);
    console.log(JSON.stringify({ ok: true, action: "automatic-relogin" }));
  } finally {
    await browser?.close().catch(() => {});
    await releaseLock();
  }
}

main().catch((error) => {
  console.error(`SpaceCloud automatic login failed: ${errorText(error)}`);
  process.exitCode = 1;
});
