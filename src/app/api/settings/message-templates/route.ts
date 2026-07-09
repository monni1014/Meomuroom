import { NextRequest, NextResponse } from "next/server";
import { getMessageTemplates, updateMessageTemplate } from "@/lib/message-templates";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const templates = await getMessageTemplates();
    return NextResponse.json({ success: true, templates });
  } catch (error) {
    console.error("Message templates GET error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load message templates" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const roomName = typeof body.roomName === "string" ? body.roomName : "";
    const content = typeof body.content === "string" ? body.content : "";

    if (!roomName || !content.trim()) {
      return NextResponse.json({ success: false, error: "roomName and content are required." }, { status: 400 });
    }

    const template = await updateMessageTemplate(roomName, content);
    return NextResponse.json({ success: true, template });
  } catch (error) {
    console.error("Message templates PATCH error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to save message template" },
      { status: 500 },
    );
  }
}
