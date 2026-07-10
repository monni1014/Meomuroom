import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RESULT_PREFIX = "__CUTOFF_CAPTURE_RESULT__";

export type CutoffCaptureResult = {
  competitorId: string;
  targetKey: string;
  checkedAt: string;
  checkedAtKst: string;
  slots: Array<{ hour: number; label: string; available: boolean; className: string }>;
  pagePath: string;
  timePath: string | null;
  lateTimePath: string | null;
  dataPath: string;
};

function enabled() {
  const value = process.env.COMPETITOR_CUTOFF_STUDY_ENABLED?.trim().toLowerCase();
  if (!["1", "true", "yes", "on"].includes(value || "")) return false;

  const until = process.env.COMPETITOR_CUTOFF_STUDY_UNTIL?.trim();
  if (!until) return true;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  return today <= until;
}

export async function captureSynergyCutoffStudy(): Promise<CutoffCaptureResult | null> {
  if (!enabled()) return null;

  const result = await execFileAsync(process.execPath, ["rpa/competitor-cutoff-capture.mjs"], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 2,
  });
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`Cutoff capture returned no result: ${result.stdout.slice(-500)}`);
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as CutoffCaptureResult;
}
