import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const adapter = new PrismaLibSql({
  url: process.env.DATABASE_URL || "file:./dev.db",
});

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaConfigured: Promise<void> | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter });

if (!globalForPrisma.prismaConfigured) {
  globalForPrisma.prismaConfigured = (async () => {
    // WAL lets readers continue while a background task writes. The busy
    // timeout prevents overlapping cron/API writes from failing immediately.
    await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  })().catch((error) => {
    globalForPrisma.prismaConfigured = undefined;
    throw error;
  });
}

await globalForPrisma.prismaConfigured;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
