import { optionalEnv } from "./env.mjs";

const mousePositions = new WeakMap();

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return (u ** 3 * p0)
    + (3 * u ** 2 * t * p1)
    + (3 * u * t ** 2 * p2)
    + (t ** 3 * p3);
}

export function randomDelayMs(minMs, maxMs) {
  const multiplier = Number(optionalEnv("RPA_DELAY_MULTIPLIER", "2.0")) || 2.0;
  const floor = Number(optionalEnv("RPA_MIN_RANDOM_DELAY_FLOOR_MS", "1200")) || 1200;
  const min = Math.max(floor, Math.round(Number(minMs) * multiplier));
  const max = Math.max(min + 250, Math.round(Number(maxMs) * multiplier));
  return randomInt(min, max);
}

export async function humanDelay(page, label = "wait", minMs, maxMs) {
  const min = Number(minMs ?? optionalEnv("RPA_MIN_DELAY_MS", "1800"));
  const max = Number(maxMs ?? optionalEnv("RPA_MAX_DELAY_MS", "5200"));
  const delay = randomDelayMs(min, max);

  console.log(`${label}: wait ${delay}ms`);
  await page.waitForTimeout(delay);
}

function getInitialMousePosition(page) {
  const viewport = page.viewportSize?.() || { width: 1440, height: 1000 };
  return {
    x: randomFloat(viewport.width * 0.25, viewport.width * 0.75),
    y: randomFloat(viewport.height * 0.25, viewport.height * 0.75),
  };
}

export async function humanMouseMove(page, targetX, targetY, label = "mouse move") {
  const start = mousePositions.get(page) || getInitialMousePosition(page);
  const viewport = page.viewportSize?.() || { width: 1440, height: 1000 };
  const distance = Math.hypot(targetX - start.x, targetY - start.y);
  const steps = Math.max(10, Math.min(34, Math.round(distance / randomFloat(28, 55))));
  const curve = randomFloat(-0.35, 0.35);
  const normalX = -(targetY - start.y) / Math.max(distance, 1);
  const normalY = (targetX - start.x) / Math.max(distance, 1);
  const curveSize = Math.min(180, Math.max(24, distance * Math.abs(curve)));

  const c1 = {
    x: start.x + (targetX - start.x) * randomFloat(0.25, 0.42) + normalX * curveSize * Math.sign(curve || 1),
    y: start.y + (targetY - start.y) * randomFloat(0.18, 0.38) + normalY * curveSize * Math.sign(curve || 1),
  };
  const c2 = {
    x: start.x + (targetX - start.x) * randomFloat(0.58, 0.82) - normalX * curveSize * randomFloat(0.35, 0.9) * Math.sign(curve || 1),
    y: start.y + (targetY - start.y) * randomFloat(0.62, 0.86) - normalY * curveSize * randomFloat(0.35, 0.9) * Math.sign(curve || 1),
  };

  console.log(`${label}: curved mouse move ${steps} steps`);

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    const jitter = i === steps ? 0 : randomFloat(-1.2, 1.2);
    const x = Math.max(1, Math.min(viewport.width - 1, bezier(start.x, c1.x, c2.x, targetX, ease) + jitter));
    const y = Math.max(1, Math.min(viewport.height - 1, bezier(start.y, c1.y, c2.y, targetY, ease) + jitter));

    await page.mouse.move(x, y);
    await page.waitForTimeout(randomInt(10, 34));
  }

  mousePositions.set(page, { x: targetX, y: targetY });
}

export async function humanClick(page, x, y, label = "mouse click") {
  const targetX = x + randomFloat(-2.5, 2.5);
  const targetY = y + randomFloat(-2.5, 2.5);

  await humanMouseMove(page, targetX, targetY, label);
  await page.waitForTimeout(randomInt(90, 260));
  await page.mouse.down();
  await page.waitForTimeout(randomInt(70, 190));
  await page.mouse.up();
  await page.waitForTimeout(randomInt(120, 360));
}

export async function humanClickBox(page, box, label = "box click") {
  if (!box) throw new Error(`Cannot click missing box: ${label}`);
  await humanClick(
    page,
    box.x + box.width * randomFloat(0.38, 0.62),
    box.y + box.height * randomFloat(0.35, 0.65),
    label,
  );
}

export async function humanClickElement(page, elementOrLocator, label = "element click") {
  const box = await elementOrLocator.boundingBox();
  if (!box) throw new Error(`Cannot click invisible element: ${label}`);
  await humanClickBox(page, box, label);
}
