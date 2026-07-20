export type RpaFailureKind = "BUSY" | "LOGIN" | "NETWORK" | "UI_CHANGE" | "FAILURE";

type ChildProcessErrorLike = {
  message?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  code?: unknown;
  signal?: unknown;
};

function textValue(value: unknown) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

export function collectRpaErrorText(error: unknown) {
  if (error instanceof Error) {
    const childError = error as Error & ChildProcessErrorLike;
    return [
      childError.message,
      textValue(childError.stderr),
      textValue(childError.stdout),
      childError.code ? `code=${String(childError.code)}` : "",
      childError.signal ? `signal=${String(childError.signal)}` : "",
    ].filter(Boolean).join("\n");
  }

  if (error && typeof error === "object") {
    const childError = error as ChildProcessErrorLike;
    return [
      textValue(childError.message),
      textValue(childError.stderr),
      textValue(childError.stdout),
    ].filter(Boolean).join("\n");
  }

  return String(error || "Unknown RPA failure");
}

export function classifyRpaFailure(errorOrText: unknown): RpaFailureKind {
  const text = typeof errorOrText === "string"
    ? errorOrText
    : collectRpaErrorText(errorOrText);

  if (/already running|lock timeout|lock exists|another RPA task is still running/i.test(text)) {
    return "BUSY";
  }

  if (
    /login required|login session is missing|session is missing or expired|saved session opened a login page|401 Unauthorized|403 Forbidden|rejected with (?:401|403)|kauth\.kakao\.com|accounts\.kakao\.com/i.test(text)
  ) {
    return "LOGIN";
  }

  if (
    /ERR_(?:PROXY|TUNNEL|CONNECTION|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)|ECONN(?:RESET|REFUSED|ABORTED)|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|socket hang up|proxy connection|tunnel connection|DNS lookup|net::/i.test(text)
  ) {
    return "NETWORK";
  }

  if (
    /\[RPA_UI_CHANGE\]|locator\.|getBy(?:Text|Role|Label)|waitForFunction|waiting for locator|selector|not visible after retry|was not visible|was not found|could not find|could not locate|did not load|grid did not load|not ready before|could not open (?:exact )?(?:Naver )?(?:schedule|calendar|product|detail)|calendar view is not ready|day header was not found|booking detail link|target day is visible/i.test(text)
  ) {
    return "UI_CHANGE";
  }

  return "FAILURE";
}

export function extractRpaEvidencePath(errorOrText: unknown) {
  const text = typeof errorOrText === "string"
    ? errorOrText
    : collectRpaErrorText(errorOrText);
  return text.match(/RPA_EVIDENCE_PATH=([^\r\n]+\.png)/i)?.[1]?.trim() || null;
}

function redactSensitiveText(value: string) {
  return value
    .replace(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/g, "010-****-****")
    .replace(/\b\d{9,14}\b/g, "[예약번호]")
    .replace(/--customer-name=[^\s]+/gi, "--customer-name=[숨김]")
    .replace(/--phone=[^\s]+/gi, "--phone=[숨김]")
    .replace(/\s+/g, " ")
    .trim();
}

export function summarizeRpaFailure(errorOrText: unknown) {
  const text = typeof errorOrText === "string"
    ? errorOrText
    : collectRpaErrorText(errorOrText);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\s*(?:at |Usage:|npm run )/.test(line));

  const preferred = [...lines].reverse().find((line) =>
    /RPA failed|RPA terminated|read failed|Error:|Timeout|not visible|not found|could not|did not|not ready|login required|session|ERR_|ECONN|ENET|EHOST|EAI_AGAIN/i.test(line)
  ) || lines.at(-1) || "Unknown RPA failure";

  return redactSensitiveText(preferred).slice(0, 500);
}
