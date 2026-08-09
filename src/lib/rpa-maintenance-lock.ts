import "server-only";

import { existsSync } from "node:fs";

const DEFAULT_LOCK_PATH = "/srv/memoroom/shared/rpa-maintenance.lock";

export function rpaMaintenanceLockPath() {
  return process.env.MEMOROOM_RPA_MAINTENANCE_LOCK_PATH || DEFAULT_LOCK_PATH;
}

export function isRpaMaintenanceActive() {
  if (process.platform !== "linux") return false;
  return existsSync(rpaMaintenanceLockPath());
}
