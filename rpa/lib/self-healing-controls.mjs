import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const STATE_VERSION = 1;
const DEFAULT_PROMOTION_PASSES = 2;
const RUNTIME_DIR = resolve("rpa/.runtime/self-healing-controls");

export function normalizeControlText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function safeStableId(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{1,80}$/.test(normalized)) return "";
  if (/[a-f0-9]{12,}/i.test(normalized) || /\d{8,}/.test(normalized)) return "";
  return normalized;
}

export function buildControlSignature(candidate) {
  const testId = String(candidate.testId || "").trim();
  if (testId) return `testid:${testId}`;

  const stableId = safeStableId(candidate.id);
  if (stableId) return `id:${stableId}`;

  const aria = normalizeControlText(candidate.ariaLabel || candidate.name || candidate.title);
  if (aria) return `aria:${candidate.tag || "control"}:${aria}`;

  const text = normalizeControlText(candidate.text || candidate.value);
  const role = normalizeControlText(candidate.role || "");
  return `text:${candidate.tag || "control"}:${role}:${text}`;
}

function bigrams(value) {
  const text = normalizeControlText(value);
  if (text.length < 2) return text ? new Set([text]) : new Set();
  const result = new Set();
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
  return result;
}

function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

function candidateTextValues(candidate) {
  return [candidate.text, candidate.ariaLabel, candidate.title, candidate.name, candidate.value]
    .map(normalizeControlText)
    .filter(Boolean);
}

function labelMatchScore(candidate, definition) {
  const values = candidateTextValues(candidate);
  const primaries = (definition.primaryLabels || []).map(normalizeControlText).filter(Boolean);
  const aliases = (definition.aliases || []).map(normalizeControlText).filter(Boolean);
  let score = 0;
  let exactPrimary = false;
  let match = "none";

  for (const value of values) {
    if (primaries.includes(value)) {
      score = Math.max(score, 120);
      exactPrimary = true;
      match = "primary-exact";
    } else if (aliases.includes(value) && score < 105) {
      score = 105;
      match = "alias-exact";
    }

    for (const primary of primaries) {
      if ((value.includes(primary) || primary.includes(value)) && score < 92) {
        score = 92;
        match = "primary-contains";
      }
      const fuzzy = similarity(value, primary);
      if (fuzzy >= 0.72 && 62 + Math.round(fuzzy * 30) > score) {
        score = 62 + Math.round(fuzzy * 30);
        match = "primary-similar";
      }
    }

    for (const alias of aliases) {
      if ((value.includes(alias) || alias.includes(value)) && score < 88) {
        score = 88;
        match = "alias-contains";
      }
      const fuzzy = similarity(value, alias);
      if (fuzzy >= 0.72 && 58 + Math.round(fuzzy * 30) > score) {
        score = 58 + Math.round(fuzzy * 30);
        match = "alias-similar";
      }
    }
  }

  const normalizedJoined = values.join("");
  const semanticTokens = (definition.semanticTokens || []).map(normalizeControlText).filter(Boolean);
  if (semanticTokens.length && semanticTokens.every((token) => normalizedJoined.includes(token)) && score < 90) {
    score = 90;
    match = "semantic-tokens";
  }

  return { score, exactPrimary, match };
}

export function rankControlCandidates(candidates, definition) {
  const minYRatio = definition.region?.minYRatio ?? 0;
  const maxYRatio = definition.region?.maxYRatio ?? 1;
  const bounds = definition.bounds || null;
  const excluded = (definition.excludeLabels || []).map(normalizeControlText).filter(Boolean);

  const ranked = candidates
    .filter((candidate) => candidate.visible && candidate.enabled !== false)
    .filter((candidate) => candidate.yRatio >= minYRatio && candidate.yRatio <= maxYRatio)
    .filter((candidate) => !bounds || (
      candidate.x >= bounds.x
      && candidate.y >= bounds.y
      && candidate.x + candidate.width <= bounds.x + bounds.width
      && candidate.y + candidate.height <= bounds.y + bounds.height
    ))
    .map((candidate) => {
      const textValues = candidateTextValues(candidate);
      if (excluded.some((label) => textValues.some((value) => value.includes(label)))) return null;

      const labelMatch = labelMatchScore(candidate, definition);
      let score = labelMatch.score;
      if (["button", "a", "input"].includes(String(candidate.tag || "").toLowerCase())) score += 8;
      if (String(candidate.role || "").toLowerCase() === "button") score += 5;
      if (candidate.testId || safeStableId(candidate.id)) score += 3;
      return {
        ...candidate,
        ...labelMatch,
        score,
        signature: buildControlSignature(candidate),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.area - right.area);

  const winner = ranked[0] || null;
  const runnerUp = ranked.find((candidate) => candidate.signature !== winner?.signature) || null;
  const margin = winner ? winner.score - (runnerUp?.score ?? 0) : 0;
  const minScore = definition.minScore ?? 85;
  const minMargin = definition.minMargin ?? 12;
  const ambiguous = Boolean(winner && runnerUp && margin < minMargin);

  return {
    winner: winner && winner.score >= minScore && !ambiguous ? winner : null,
    ranked,
    ambiguous,
    margin,
    minScore,
    minMargin,
  };
}

function emptyState(key) {
  return {
    version: STATE_VERSION,
    key,
    activeSignature: null,
    activeCandidate: null,
    pendingSignature: null,
    pendingCandidate: null,
    pendingPasses: 0,
    lastVerifiedAt: null,
    lastFailureAt: null,
    history: [],
  };
}

export function advanceControlVerificationState(currentState, candidate, {
  healthCheck = false,
  verified = true,
  now = new Date().toISOString(),
  requiredPasses = DEFAULT_PROMOTION_PASSES,
} = {}) {
  const state = { ...emptyState(currentState?.key || "control"), ...(currentState || {}) };
  const signature = candidate?.signature || buildControlSignature(candidate || {});
  const candidateSummary = candidate ? {
    signature,
    tag: candidate.tag || "",
    role: candidate.role || "",
    text: String(candidate.text || candidate.ariaLabel || candidate.value || "").slice(0, 120),
    match: candidate.match || "",
  } : null;

  if (!verified) {
    state.lastFailureAt = now;
    if (state.pendingSignature === signature) {
      state.pendingSignature = null;
      state.pendingCandidate = null;
      state.pendingPasses = 0;
    }
    state.history = [...(state.history || []), { at: now, event: "failed", signature }].slice(-20);
    return state;
  }

  state.lastVerifiedAt = now;
  if (state.activeSignature === signature) {
    state.activeCandidate = candidateSummary;
    state.pendingSignature = null;
    state.pendingCandidate = null;
    state.pendingPasses = 0;
    state.history = [...(state.history || []), { at: now, event: "active-verified", signature }].slice(-20);
    return state;
  }

  if (!healthCheck) {
    state.history = [...(state.history || []), { at: now, event: "live-primary-verified", signature }].slice(-20);
    return state;
  }

  if (state.pendingSignature === signature) {
    state.pendingPasses += 1;
  } else {
    state.pendingSignature = signature;
    state.pendingCandidate = candidateSummary;
    state.pendingPasses = 1;
  }

  state.history = [...(state.history || []), {
    at: now,
    event: "health-verified",
    signature,
    passes: state.pendingPasses,
  }].slice(-20);

  if (state.pendingPasses >= requiredPasses) {
    state.activeSignature = signature;
    state.activeCandidate = candidateSummary;
    state.pendingSignature = null;
    state.pendingCandidate = null;
    state.pendingPasses = 0;
    state.history = [...state.history, { at: now, event: "promoted", signature }].slice(-20);
  }

  return state;
}

function statePath(key) {
  const safeKey = String(key || "control").replace(/[^A-Za-z0-9_.-]+/g, "-");
  return resolve(RUNTIME_DIR, `${safeKey}.json`);
}

function readState(key) {
  const filePath = statePath(key);
  if (!existsSync(filePath)) return emptyState(key);
  try {
    return { ...emptyState(key), ...JSON.parse(readFileSync(filePath, "utf8")), key };
  } catch {
    return emptyState(key);
  }
}

function writeState(key, state) {
  const filePath = statePath(key);
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function persistState(key, state, { strict = false } = {}) {
  try {
    writeState(key, state);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[SELF_HEAL_STATE_WARNING] ${key}: ${message}`);
    if (strict) {
      throw new Error(`[RPA_STATE] Could not persist self-healing control state for ${key}: ${message}`);
    }
    return false;
  }
}

async function collectCandidates(page, marker) {
  return page.evaluate((targetMarker) => {
    const markerAttribute = "data-memoroom-control-probe";
    for (const previous of document.querySelectorAll(`[${markerAttribute}]`)) previous.removeAttribute(markerAttribute);

    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && Number(style.opacity || 1) > 0.05
        && rect.width > 0
        && rect.height > 0;
    }

    const selectors = "button,a,[role='button'],input[type='button'],input[type='submit'],[onclick],[data-testid],div,span";
    const seen = new Set();
    const controls = [];

    for (const element of document.querySelectorAll(selectors)) {
      const style = window.getComputedStyle(element);
      const semantic = element.matches("button,a,[role='button'],input[type='button'],input[type='submit'],[onclick],[data-testid]");
      if (!semantic && style.cursor !== "pointer" && element.tabIndex < 0) continue;

      const clickable = element.closest("button,a,[role='button'],input[type='button'],input[type='submit'],[onclick],[data-testid]") || element;
      if (seen.has(clickable) || !visible(clickable)) continue;
      seen.add(clickable);

      const rect = clickable.getBoundingClientRect();
      const index = controls.length;
      const probeValue = `${targetMarker}-${index}`;
      clickable.setAttribute(markerAttribute, probeValue);
      controls.push({
        marker: probeValue,
        tag: clickable.tagName.toLowerCase(),
        role: clickable.getAttribute("role") || "",
        text: (clickable.innerText || clickable.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
        ariaLabel: clickable.getAttribute("aria-label") || "",
        title: clickable.getAttribute("title") || "",
        name: clickable.getAttribute("name") || "",
        value: clickable.getAttribute("value") || "",
        id: clickable.id || "",
        testId: clickable.getAttribute("data-testid") || clickable.getAttribute("data-test-id") || "",
        visible: true,
        enabled: !(clickable.disabled || clickable.getAttribute("aria-disabled") === "true"),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        area: rect.width * rect.height,
        yRatio: Math.max(0, Math.min(1, (rect.y + rect.height / 2) / window.innerHeight)),
      });
    }

    return controls;
  }, marker);
}

export async function locateSelfHealingControl(page, definition, { healthCheck = false } = {}) {
  if (!definition?.key) throw new Error("Self-healing control definition requires a key.");
  const marker = randomUUID();
  const candidates = await collectCandidates(page, marker);
  const state = readState(definition.key);
  const enriched = candidates.map((candidate) => ({ ...candidate, signature: buildControlSignature(candidate) }));

  let winner = null;
  let reason = "semantic";
  if (state.activeSignature) {
    const activeMatches = enriched.filter((candidate) => candidate.signature === state.activeSignature);
    if (activeMatches.length === 1) {
      const rankedActive = rankControlCandidates(activeMatches, { ...definition, minMargin: 0 });
      if (rankedActive.winner) {
        winner = rankedActive.winner;
        reason = "active-signature";
      }
    } else if (activeMatches.length > 1) {
      throw new Error(`[RPA_UI_CHANGE] ${definition.key}: promoted control is no longer unique.`);
    }
  }

  if (!winner) {
    const ranked = rankControlCandidates(enriched, definition);
    if (!ranked.winner) {
      const top = ranked.ranked.slice(0, 3).map((candidate) => ({
        text: candidate.text,
        score: candidate.score,
        signature: candidate.signature,
      }));
      const detail = ranked.ambiguous ? "ambiguous candidates" : "no sufficiently safe candidate";
      throw new Error(`[RPA_UI_CHANGE] ${definition.key}: ${detail}; top=${JSON.stringify(top)}`);
    }
    winner = ranked.winner;
  }

  const promoted = state.activeSignature === winner.signature && reason === "active-signature";
  if (!healthCheck && !winner.exactPrimary && !promoted) {
    throw new Error(
      `[RPA_UI_CHANGE] ${definition.key}: changed control was found but is not promoted yet (${winner.text || winner.ariaLabel}).`,
    );
  }

  const locator = page.locator(`[data-memoroom-control-probe="${winner.marker}"]`).first();
  if (await locator.count() !== 1) {
    throw new Error(`[RPA_UI_CHANGE] ${definition.key}: selected control disappeared before use.`);
  }

  console.log(`[SELF_HEAL_${promoted ? "ACTIVE" : "CANDIDATE"}] ${definition.key} ${winner.signature} match=${winner.match || reason}`);
  return { definition, candidate: winner, locator, healthCheck, promoted, reason };
}

export function markSelfHealingControlVerified(control, { healthCheck = control.healthCheck } = {}) {
  const before = readState(control.definition.key);
  const after = advanceControlVerificationState(before, control.candidate, { healthCheck, verified: true });
  const persisted = persistState(control.definition.key, after, { strict: healthCheck });

  if (persisted && before.activeSignature !== after.activeSignature && after.activeSignature) {
    console.log(`[SELF_HEAL_PROMOTED] ${control.definition.key} ${after.activeSignature}`);
  } else if (persisted && healthCheck && !after.activeSignature) {
    console.log(`[SELF_HEAL_PENDING] ${control.definition.key} passes=${after.pendingPasses}/${DEFAULT_PROMOTION_PASSES}`);
  }
  return after;
}

export function markSelfHealingControlFailed(control) {
  const before = readState(control.definition.key);
  const after = advanceControlVerificationState(before, control.candidate, { healthCheck: control.healthCheck, verified: false });
  persistState(control.definition.key, after);
  console.log(`[SELF_HEAL_FAILED] ${control.definition.key} ${control.candidate.signature}`);
  return after;
}
