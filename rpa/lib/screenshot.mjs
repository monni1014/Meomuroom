import { resolve } from "node:path";
import { ensureDir, screenshotDir } from "./paths.mjs";

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function saveScreenshot(page, name, options = {}) {
  ensureDir(screenshotDir);
  const filePath = resolve(screenshotDir, `${name}-${timestamp()}.png`);
  await page.screenshot({ path: filePath, fullPage: true, ...options });
  return filePath;
}
