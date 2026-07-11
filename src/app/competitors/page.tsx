import CompetitorsView from "./CompetitorsView";
import { getCompetitorSnapshots } from "@/lib/competitor-snapshots";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function currentKstYearMonth() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
  };
}

export default async function CompetitorsPage() {
  const { year, month } = currentKstYearMonth();
  const [initialSnapshots, initialManualCells] = await Promise.all([
    getCompetitorSnapshots(year, month),
    prisma.manualTableCell.findMany({
      where: { tableId: "competitors", year, month },
      orderBy: [{ sectionId: "asc" }, { day: "asc" }, { cellKey: "asc" }],
      select: {
        sectionId: true,
        year: true,
        month: true,
        day: true,
        cellKey: true,
        value: true,
        color: true,
      },
    }),
  ]);
  return <CompetitorsView initialSnapshots={initialSnapshots} initialManualCells={initialManualCells} />;
}
