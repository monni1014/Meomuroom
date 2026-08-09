import assert from "node:assert/strict";
import { extractEmailAddress, extractKakaoLoginCode, isExactKakaoLoginMessage } from "../rpa/lib/gmail-kakao-verification.mjs";

function message({
  from = "카카오팀 <noreply@kakaocorp.com>",
  subject = "[카카오계정] 로그인 인증번호",
  internalDate = 2_000,
  body = "카카오계정 로그인을 위한 인증번호입니다. 65817404",
} = {}) {
  return {
    id: "gmail-message-id",
    internalDate: String(internalDate),
    payload: {
      headers: [{ name: "From", value: from }, { name: "Subject", value: subject }],
      mimeType: "text/plain",
      body: { data: Buffer.from(body).toString("base64url") },
    },
  };
}

assert.equal(extractEmailAddress("카카오팀 <noreply@kakaocorp.com>"), "noreply@kakaocorp.com");
assert.equal(extractKakaoLoginCode(message()), "65817404");
assert.equal(isExactKakaoLoginMessage(message(), 1_999), true);
assert.equal(isExactKakaoLoginMessage(message({ internalDate: 1_998 }), 1_999), false);
assert.equal(isExactKakaoLoginMessage(message({ from: "other@example.com" }), 1_999), false);
assert.equal(isExactKakaoLoginMessage(message({ subject: "다른 제목" }), 1_999), false);
assert.throws(
  () => extractKakaoLoginCode(message({ body: "로그인을 위한 인증번호입니다. 12345678 / 87654321" })),
  /2 distinct/,
);
console.log("Kakao Gmail verification fingerprint tests passed.");
