export function formatSolapiMessageText(text: string) {
  const body = text.replace(/\r\n/g, "\n").trim();
  return body ? `\n${body}` : "";
}
