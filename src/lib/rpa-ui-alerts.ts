import { createAdminAlert, resolveAdminAlertByDedupeKey } from "@/lib/admin-alerts";
import {
  classifyRpaFailure,
  collectRpaErrorText,
  extractRpaEvidencePath,
  summarizeRpaFailure,
  type RpaFailureKind,
} from "@/lib/rpa-failure-classifier";

type ScriptMetadata = {
  platformKey: "naver" | "spacecloud" | "unknown";
  platformLabel: string;
  operationKey: string;
  operationLabel: string;
};

const ALERT_KINDS: Exclude<RpaFailureKind, "BUSY">[] = [
  "LOGIN",
  "NETWORK",
  "UI_CHANGE",
  "FAILURE",
];

function scriptMetadata(scriptPath: string): ScriptMetadata {
  const normalized = scriptPath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("naver-toggle-slots")) {
    return {
      platformKey: "naver",
      platformLabel: "네이버",
      operationKey: "slot-calendar",
      operationLabel: "슬롯 일정 화면",
    };
  }
  if (normalized.includes("naver-read-booking-detail")) {
    return {
      platformKey: "naver",
      platformLabel: "네이버",
      operationKey: "booking-detail",
      operationLabel: "예약 상세 화면",
    };
  }
  if (normalized.includes("spacecloud-external-reservation")) {
    return {
      platformKey: "spacecloud",
      platformLabel: "스페이스클라우드",
      operationKey: "reservation-calendar",
      operationLabel: "예약 캘린더 화면",
    };
  }
  if (normalized.includes("spacecloud-read-reservation-detail")) {
    return {
      platformKey: "spacecloud",
      platformLabel: "스페이스클라우드",
      operationKey: "reservation-detail",
      operationLabel: "예약 상세 화면",
    };
  }

  const filename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") || "unknown-script";
  return {
    platformKey: normalized.includes("naver")
      ? "naver"
      : normalized.includes("spacecloud")
        ? "spacecloud"
        : "unknown",
    platformLabel: normalized.includes("naver")
      ? "네이버"
      : normalized.includes("spacecloud")
        ? "스페이스클라우드"
        : "예약 사이트",
    operationKey: filename,
    operationLabel: "RPA 화면",
  };
}

function dedupeKey(metadata: ScriptMetadata, kind: Exclude<RpaFailureKind, "BUSY">) {
  return `rpa-health:${metadata.platformKey}:${metadata.operationKey}:${kind.toLowerCase()}`;
}

function alertCopy(metadata: ScriptMetadata, kind: Exclude<RpaFailureKind, "BUSY">) {
  if (kind === "UI_CHANGE") {
    return {
      type: "RPA_UI_CHANGE",
      severity: "CRITICAL" as const,
      title: `${metadata.platformLabel} 화면 변경 의심`,
      description: `${metadata.operationLabel}에서 기존 버튼·문구·구조를 찾지 못했습니다.`,
    };
  }
  if (kind === "LOGIN") {
    return {
      type: "RPA_LOGIN_SESSION",
      severity: "CRITICAL" as const,
      title: `${metadata.platformLabel} 로그인 확인 필요`,
      description: `${metadata.operationLabel}의 로그인 세션이 만료되었거나 권한이 거부되었습니다.`,
    };
  }
  if (kind === "NETWORK") {
    return {
      type: "RPA_NETWORK",
      severity: "WARNING" as const,
      title: `${metadata.platformLabel} 접속 장애`,
      description: `${metadata.operationLabel} 점검 중 프록시 또는 네트워크 오류가 발생했습니다.`,
    };
  }
  return {
    type: "RPA_FAILURE",
    severity: "CRITICAL" as const,
    title: `${metadata.platformLabel} RPA 오류`,
    description: `${metadata.operationLabel} 자동화가 정상 완료되지 않았습니다.`,
  };
}

export async function reportRpaScriptFailure(error: unknown, scriptPath: string) {
  const text = collectRpaErrorText(error);
  const kind = classifyRpaFailure(text);
  if (kind === "BUSY") return { kind, alerted: false };

  const metadata = scriptMetadata(scriptPath);
  const copy = alertCopy(metadata, kind);
  const evidencePath = extractRpaEvidencePath(text);
  const message = [
    copy.description,
    `오류: ${summarizeRpaFailure(text)}`,
    evidencePath ? `증거 화면: ${evidencePath}` : null,
    "해당 단계는 성공으로 처리하지 않았으며 확인 전까지 자동 재시도 대상입니다.",
  ].filter(Boolean).join(" ");

  await createAdminAlert({
    type: copy.type,
    severity: copy.severity,
    title: copy.title,
    message,
    dedupeKey: dedupeKey(metadata, kind),
  });

  return { kind, alerted: true, evidencePath };
}

export async function resolveRpaScriptAlerts(scriptPath: string) {
  const metadata = scriptMetadata(scriptPath);
  await Promise.all(
    ALERT_KINDS.map((kind) => resolveAdminAlertByDedupeKey(dedupeKey(metadata, kind))),
  );
}
