const REPLACEMENT_CHARACTER = "\uFFFD";
const LONG_QUESTION_MARK_RUN = /\?{3,}/u;

export function findSolapiTextEncodingIssue(text: string) {
  if (text.includes(REPLACEMENT_CHARACTER)) {
    return "본문에 깨진 대체문자(�)가 포함되어 있습니다.";
  }

  if (LONG_QUESTION_MARK_RUN.test(text)) {
    return "본문에 인코딩 손상으로 의심되는 연속 물음표(???)가 포함되어 있습니다.";
  }

  return null;
}

