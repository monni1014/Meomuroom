import CompetitorsView from "./CompetitorsView";
import { getCompetitorSnapshots } from "@/lib/competitor-snapshots";

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
  const initialSnapshots = await getCompetitorSnapshots(year, month);
  return <CompetitorsView initialSnapshots={initialSnapshots} />;
}
