import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const chromeRoot = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "Google",
  "Chrome",
  "User Data",
);
const localStatePath = path.join(chromeRoot, "Local State");
const runRoot = path.join(os.tmpdir(), "memoroom-vultr-bootstrap");
const profileRoot = path.join(runRoot, "chrome-profile");
const screenshotPath = path.join(runRoot, "vultr-session.png");
const statusPath = path.join(runRoot, "status.json");

function writeStatus(status, extra = {}) {
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(
    statusPath,
    JSON.stringify({ status, ...extra, updatedAt: new Date().toISOString() }, null, 2),
  );
}

function copyChromeProfile() {
  const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
  const profileName = localState.profile?.last_used || "Default";
  const sourceProfile = path.join(chromeRoot, profileName);

  fs.rmSync(profileRoot, { recursive: true, force: true });
  fs.mkdirSync(profileRoot, { recursive: true });
  fs.copyFileSync(localStatePath, path.join(profileRoot, "Local State"));

  const destinationProfile = path.join(profileRoot, profileName);
  fs.mkdirSync(destinationProfile, { recursive: true });

  const excludedDirectories = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "Service Worker\\CacheStorage",
    "Service Worker\\ScriptCache",
    "Sessions",
  ];
  const excludedFiles = [
    "LOCK",
    "LOG",
    "LOG.old",
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
  ];

  const args = [
    sourceProfile,
    destinationProfile,
    "/E",
    "/R:1",
    "/W:1",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP",
    "/XD",
    ...excludedDirectories.map((item) => path.join(sourceProfile, item)),
    "/XF",
    ...excludedFiles,
  ];

  try {
    execFileSync("robocopy.exe", args, { stdio: "ignore" });
  } catch (error) {
    // Robocopy uses exit codes 0-7 for successful copies with differences.
    const code = Number(error?.status ?? 16);
    if (code > 7) throw error;
  }

  return profileName;
}

async function main() {
  writeStatus("copying-profile");
  const profileName = copyChromeProfile();
  writeStatus("opening-browser", { profileName });

  const context = await chromium.launchPersistentContext(profileRoot, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1500, height: 950 },
    args: [
      `--profile-directory=${profileName}`,
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--no-first-run",
    ],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://my.vultr.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(5_000);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const url = page.url();
    const bodyText = (await page.locator("body").innerText()).slice(0, 10_000);
    const loggedIn =
      !/login|sign in/i.test(url) &&
      /Instances|Products|Dashboard|memoroom-server|158\.247\.221\.25/i.test(bodyText);

    writeStatus(loggedIn ? "logged-in" : "login-required", {
      url,
      screenshotPath,
      title: await page.title(),
    });

    if (loggedIn) {
      const instanceLink = page
        .getByRole("link", { name: /memoroom-server/i })
        .or(page.getByText("158.247.221.25", { exact: false }))
        .first();
      if (await instanceLink.isVisible().catch(() => false)) {
        await instanceLink.click();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(4_000);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        writeStatus("instance-opened", {
          url: page.url(),
          screenshotPath,
          title: await page.title(),
        });
      }
    }

    await page.waitForTimeout(10_000);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  writeStatus("failed", { error: String(error?.message ?? error) });
  process.exitCode = 1;
});
