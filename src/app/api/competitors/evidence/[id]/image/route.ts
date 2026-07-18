import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeEvidencePath(imagePath: string) {
  const root = resolve(process.cwd(), "rpa/screenshots");
  const absolutePath = isAbsolute(imagePath)
    ? resolve(imagePath)
    : resolve(process.cwd(), imagePath);
  const fromRoot = relative(root, absolutePath);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return null;
  return absolutePath;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const evidence = await prisma.competitorEvidence.findUnique({
    where: { id },
    select: { imagePath: true },
  });
  if (!evidence) return new Response("Not found", { status: 404 });

  const imagePath = safeEvidencePath(evidence.imagePath);
  if (!imagePath) return new Response("Invalid evidence path", { status: 403 });

  try {
    const image = await readFile(imagePath);
    return new Response(new Uint8Array(image), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": "inline",
      },
    });
  } catch (error) {
    console.error("Competitor evidence image error:", error);
    return new Response("Evidence image not found", { status: 404 });
  }
}
