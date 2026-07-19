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
    // timeout must be installed before any pragma that may need a write lock.
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 10000");

    const journalRows = await prisma.$queryRawUnsafe("PRAGMA journal_mode") as Array<Record<string, unknown>>;
    const journalMode = String(Object.values(journalRows[0] || {})[0] || "").toLowerCase();
    if (journalMode !== "wal") {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
          break;
        } catch (error) {
          if (attempt === 5) throw error;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 250));
        }
      }
    }
  })().catch((error) => {
    globalForPrisma.prismaConfigured = undefined;
    throw error;
  });
}

await globalForPrisma.prismaConfigured;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
