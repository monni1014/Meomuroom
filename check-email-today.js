const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const start = new Date();
  start.setHours(0,0,0,0);
  const end = new Date();
  end.setHours(23,59,59,999);

  const res = await prisma.reservation.findMany({
    where: {
      createdAt: { gte: start, lte: end },
      emailId: { not: null }
    }
  });

  console.log(`Email reservations created today: ${res.length}`);
  res.forEach(r => console.log(`- [${r.source}] ${r.customerName} : ${r.startTime.toISOString()} (status: ${r.status}, emailId: ${r.emailId})`));
})();
