import { prisma } from "./prisma";

export async function markEmailProcessed(
  messageId: string,
  source?: string | null,
  reservationId?: string | null,
) {
  await prisma.$transaction([
    prisma.processedEmail.upsert({
      where: { messageId },
      update: {
        source: source || undefined,
        reservationId: reservationId || undefined,
      },
      create: {
        messageId,
        source: source || undefined,
        reservationId: reservationId || undefined,
      },
    }),
    prisma.pendingImapEmail.deleteMany({ where: { messageId } }),
  ]);
}
