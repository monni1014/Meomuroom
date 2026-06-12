import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.reservation.updateMany({
    where: {
      customerName: {
        contains: '한국경제'
      }
    },
    data: {
      isCleanUpBad: true
    }
  });
  console.log(`Updated ${result.count} records`);
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
