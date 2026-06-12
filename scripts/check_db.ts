import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const records = await prisma.reservation.findMany({
    where: {
      customerName: {
        contains: '한국경제'
      }
    },
    select: {
      id: true,
      customerName: true,
      startTime: true,
      isCleanUpBad: true,
    }
  });

  console.log(records);
}

main().catch(console.error).finally(() => prisma.$disconnect());
