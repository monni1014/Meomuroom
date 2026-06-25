import { optionalEnv } from "./env.mjs";

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomDelayMs(minMs, maxMs) {
  return randomInt(Math.max(500, minMs), Math.max(500, maxMs));
}

export async function humanDelay(page, label = "wait", minMs, maxMs) {
  const min = Number(minMs ?? optionalEnv("RPA_MIN_DELAY_MS", "900"));
  const max = Number(maxMs ?? optionalEnv("RPA_MAX_DELAY_MS", "2200"));
  const delay = randomDelayMs(min, max);

  console.log(`${label}: wait ${delay}ms`);
  await page.waitForTimeout(delay);
}
