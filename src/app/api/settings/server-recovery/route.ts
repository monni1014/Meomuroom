import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getPlannedRestartReadiness } from "@/lib/planned-restart-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_HEADER = "safe-app-restart-v1";
const REQUEST_PATH = process.env.MEMOROOM_MANUAL_RECOVERY_REQUEST_PATH
  || "/srv/memoroom/shared/manual-recovery.request";
const RESULT_PATH = process.env.MEMOROOM_MANUAL_RECOVERY_RESULT_PATH
  || "/srv/memoroom/shared/manual-recovery-result.json";
const REQUEST_STALE_MS = 5 * 60 * 1000;

type RecoveryResult = {
  requestId: string;
  status: "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";
  message: string;
  updatedAt: string;
};

const busyReasonLabels: Record<string, string> = {
  "reservation-rpa-running": "예약 RPA 실행",
  "reservation-rpa-queued": "예약 RPA 대기",
  "reservation-rpa-active": "예약 RPA 처리",
  "slot-recheck-running": "슬롯 재확인",
  "naver-status-reconcile-running": "네이버 예약 상태 점검",
  "competitor-scan-running": "경쟁사 현황 점검",
  "customer-sms-sending": "고객 문자 발송",
};

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(data, { ...init, headers });
}

function isAuthorizedAction(request: Request) {
  return request.headers.get("x-memoroom-recovery") === ACTION_HEADER;
}

function isRecoveryEnabled() {
  return process.platform === "linux"
    && process.env.MEMOROOM_MANUAL_RECOVERY_ENABLED?.trim().toLowerCase() === "true";
}

async function hasActiveRequest() {
  try {
    const fileStat = await stat(REQUEST_PATH);
    if (Date.now() - fileStat.mtimeMs <= REQUEST_STALE_MS) return true;
    await unlink(REQUEST_PATH).catch(() => undefined);
    return false;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedAction(request)) {
    return json({ success: false, error: "허용되지 않은 복구 요청입니다." }, { status: 403 });
  }
  if (!isRecoveryEnabled()) {
    return json({ success: false, error: "이 서버에서는 안전 복구 기능을 사용할 수 없습니다." }, { status: 503 });
  }

  let body: { confirmation?: string } = {};
  try {
    body = await request.json() as { confirmation?: string };
  } catch {
    return json({ success: false, error: "복구 요청 형식이 올바르지 않습니다." }, { status: 400 });
  }
  if (body.confirmation !== "SAFE_APP_RESTART") {
    return json({ success: false, error: "안전 복구 확인값이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    if (await hasActiveRequest()) {
      return json({ success: false, error: "이미 안전 복구를 진행하고 있습니다." }, { status: 409 });
    }

    const readiness = await getPlannedRestartReadiness();
    if (!readiness.idle) {
      const labels = readiness.reasons.map((reason) => busyReasonLabels[reason] || reason);
      return json({
        success: false,
        code: "BUSY",
        error: `현재 ${labels.join(", ")} 중이라 재시작하지 않았습니다.`,
        reasons: readiness.reasons,
      }, { status: 409 });
    }

    const requestId = randomUUID();
    const temporaryPath = `${REQUEST_PATH}.${requestId}.tmp`;
    await mkdir(dirname(REQUEST_PATH), { recursive: true });
    await access(dirname(REQUEST_PATH));
    await writeFile(temporaryPath, `${requestId}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, REQUEST_PATH);

    return json({
      success: true,
      requestId,
      message: "안전 복구를 시작했습니다. 잠시 후 자동으로 정상 여부를 확인합니다.",
    }, { status: 202 });
  } catch (error) {
    console.error("Manual server recovery request failed:", error);
    return json({
      success: false,
      error: error instanceof Error ? error.message : "안전 복구를 시작하지 못했습니다.",
    }, { status: 500 });
  }
}

export async function GET(request: Request) {
  if (!isAuthorizedAction(request)) {
    return json({ error: "허용되지 않은 복구 확인 요청입니다." }, { status: 403 });
  }

  const requestId = new URL(request.url).searchParams.get("requestId")?.trim();
  if (!requestId) return json({ error: "복구 요청 번호가 없습니다." }, { status: 400 });

  try {
    const result = JSON.parse(await readFile(RESULT_PATH, "utf8")) as RecoveryResult;
    if (result.requestId !== requestId) {
      return json({ requestId, status: "PENDING", message: "복구 담당이 요청을 확인하고 있습니다." });
    }
    return json(result);
  } catch {
    return json({ requestId, status: "PENDING", message: "복구 담당이 요청을 확인하고 있습니다." });
  }
}
