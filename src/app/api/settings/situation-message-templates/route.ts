import { NextRequest, NextResponse } from "next/server";
import {
  getSituationMessageTemplates,
  isSituationMessageTemplateKey,
  updateSituationMessageTemplate,
} from "@/lib/situation-message-templates";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const templates = await getSituationMessageTemplates();
    return NextResponse.json({ success: true, templates });
  } catch (error) {
    console.error("Situation message templates GET error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "상황별 문자 템플릿을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const key = typeof body.key === "string" ? body.key : "";
    const subject = typeof body.subject === "string" ? body.subject : "";
    const content = typeof body.content === "string" ? body.content : "";
    const roomContents = body.roomContents && typeof body.roomContents === "object" && !Array.isArray(body.roomContents)
      ? body.roomContents
      : null;

    if (!isSituationMessageTemplateKey(key)) {
      return NextResponse.json({ success: false, error: "올바른 상황별 템플릿을 선택해주세요." }, { status: 400 });
    }

    const template = await updateSituationMessageTemplate(key, subject, content, roomContents);
    return NextResponse.json({ success: true, template });
  } catch (error) {
    console.error("Situation message templates PATCH error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "상황별 문자 템플릿을 저장하지 못했습니다." },
      { status: 500 },
    );
  }
}
