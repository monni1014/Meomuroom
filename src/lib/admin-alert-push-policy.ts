const OPERATIONAL_PUSH_TYPES = new Set([
  "RPA_UI_CHANGE",
  "RPA_LOGIN_SESSION",
  "RPA_NETWORK",
  "RPA_FAILURE",
]);

export function shouldSendAdminAlertPush(type: string, severity: string) {
  return severity === "CRITICAL" || OPERATIONAL_PUSH_TYPES.has(type);
}
