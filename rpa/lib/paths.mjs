import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const rpaRoot = resolve("rpa");
export const naverStorageStatePath = resolve("rpa/.auth/naver-storage-state.json");
export const spaceCloudStorageStatePath = resolve("rpa/.auth/spacecloud-storage-state.json");
export const spaceCloudSessionMetaPath = resolve("rpa/.auth/spacecloud-session-meta.json");
export const screenshotDir = resolve("rpa/screenshots");

export function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}
