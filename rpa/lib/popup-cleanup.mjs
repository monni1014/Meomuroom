const AUTH_HOSTS = new Set([
  "accounts.kakao.com",
  "kauth.kakao.com",
  "logins.daum.net",
  "nid.naver.com",
]);

const AUTH_PATH_PATTERN = /(?:auth|captcha|cert|login|oauth|verify)/i;

export function isProtectedRpaPopupUrl(rawUrl) {
  if (!rawUrl || rawUrl === "about:blank") return false;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;
    if (AUTH_HOSTS.has(url.hostname.toLowerCase())) return true;
    return AUTH_PATH_PATTERN.test(`${url.pathname}${url.search}`);
  } catch {
    // An unknown URL is left open instead of risking an incorrect close.
    return true;
  }
}

export function shouldCloseRpaPage({
  ageMs,
  hadOpener,
  role,
  url,
  popupGraceMs,
  orphanGraceMs,
}) {
  if (role || isProtectedRpaPopupUrl(url)) return false;
  return ageMs >= (hadOpener ? popupGraceMs : orphanGraceMs);
}
