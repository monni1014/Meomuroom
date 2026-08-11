import {
  emptyManualCell,
  manualCellDataEquals,
  type ManualCellData,
  type PaintSelection,
} from "./manual-table-colors";

export const MONTHLY_FAKE_BLOCK_LABEL = "뻥카";

interface MonthlyTablePaintChangeOptions {
  cells: Record<string, ManualCellData>;
  sectionId: string;
  dateKey: string;
  cellKey: string;
  selection: Exclude<PaintSelection, null>;
}

function buildCellKey(sectionId: string, dateKey: string, hour: number) {
  return `${sectionId}|${dateKey}|hour-${hour}`;
}

function readHour(cellKey: string) {
  const match = /^hour-(\d+)$/.exec(cellKey);
  return match ? Number(match[1]) : null;
}

function currentCell(
  cells: Record<string, ManualCellData>,
  changes: Record<string, ManualCellData>,
  key: string,
) {
  return changes[key] || cells[key] || emptyManualCell();
}

function assignChange(
  cells: Record<string, ManualCellData>,
  changes: Record<string, ManualCellData>,
  key: string,
  nextCell: ManualCellData,
) {
  const original = cells[key] || emptyManualCell();
  if (manualCellDataEquals(original, nextCell)) {
    delete changes[key];
    return;
  }
  changes[key] = nextCell;
}

function fakeBlockRange(
  cells: Record<string, ManualCellData>,
  changes: Record<string, ManualCellData>,
  sectionId: string,
  dateKey: string,
  seedHour: number,
) {
  const isFakeBlock = (hour: number) => (
    currentCell(cells, changes, buildCellKey(sectionId, dateKey, hour)).color === "fake-block"
  );

  if (!isFakeBlock(seedHour)) return null;

  let startHour = seedHour;
  let endHour = seedHour;
  while (isFakeBlock(startHour - 1)) startHour -= 1;
  while (isFakeBlock(endHour + 1)) endHour += 1;
  return { startHour, endHour };
}

function normalizeFakeBlockLabel(
  cells: Record<string, ManualCellData>,
  changes: Record<string, ManualCellData>,
  sectionId: string,
  dateKey: string,
  seedHour: number,
) {
  const range = fakeBlockRange(cells, changes, sectionId, dateKey, seedHour);
  if (!range) return;

  const firstKey = buildCellKey(sectionId, dateKey, range.startHour);
  const firstCell = currentCell(cells, changes, firstKey);
  const firstValue = firstCell.value.trim();

  // 이미 사용자가 다른 메모를 입력한 첫 칸은 덮어쓰지 않는다.
  if (firstValue && firstValue !== MONTHLY_FAKE_BLOCK_LABEL) return;

  assignChange(cells, changes, firstKey, {
    ...firstCell,
    value: MONTHLY_FAKE_BLOCK_LABEL,
  });

  for (let hour = range.startHour + 1; hour <= range.endHour; hour += 1) {
    const key = buildCellKey(sectionId, dateKey, hour);
    const cell = currentCell(cells, changes, key);
    if (cell.value.trim() !== MONTHLY_FAKE_BLOCK_LABEL) continue;
    assignChange(cells, changes, key, { ...cell, value: "" });
  }
}

export function buildMonthlyTablePaintChanges({
  cells,
  sectionId,
  dateKey,
  cellKey,
  selection,
}: MonthlyTablePaintChangeOptions) {
  const hour = readHour(cellKey);
  const key = `${sectionId}|${dateKey}|${cellKey}`;
  const originalTarget = cells[key] || emptyManualCell();
  const changes: Record<string, ManualCellData> = {};
  const nextColor = selection === "clear" ? null : selection;
  const nextTarget = {
    ...originalTarget,
    color: nextColor,
    value: originalTarget.color === "fake-block"
      && nextColor !== "fake-block"
      && originalTarget.value.trim() === MONTHLY_FAKE_BLOCK_LABEL
      ? ""
      : originalTarget.value,
  };

  assignChange(cells, changes, key, nextTarget);
  if (hour === null) return changes;

  if (nextColor === "fake-block") {
    normalizeFakeBlockLabel(cells, changes, sectionId, dateKey, hour);
    return changes;
  }

  // 첫 칸을 지우거나 다른 색으로 바꾸면 남은 오른쪽 블록의 첫 칸으로 라벨을 옮긴다.
  normalizeFakeBlockLabel(cells, changes, sectionId, dateKey, hour + 1);
  return changes;
}
