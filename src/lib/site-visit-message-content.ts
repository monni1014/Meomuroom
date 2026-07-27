import type { CleaningRoomName } from "./cleaning-schedule";

const SITE_VISIT_ROOM_NAMES: CleaningRoomName[] = ["머무룸1", "머무룸2", "머무룸3"];

function parseSiteVisitRoomNames(value: string) {
  if (value === "전체") return [...SITE_VISIT_ROOM_NAMES];
  return SITE_VISIT_ROOM_NAMES.filter((roomName) =>
    value.split(",").map((item) => item.trim()).includes(roomName),
  );
}

export type SiteVisitRoomMessageContents = Partial<Record<CleaningRoomName, string>> | null;

function roomContent(
  roomName: CleaningRoomName,
  roomContents: SiteVisitRoomMessageContents,
  legacyContent: string,
) {
  if (roomContents && Object.prototype.hasOwnProperty.call(roomContents, roomName)) {
    return roomContents[roomName]?.trim() || "";
  }
  return legacyContent.trim();
}

export function hasAnySiteVisitMessageContent(
  roomContents: SiteVisitRoomMessageContents,
  legacyContent: string,
) {
  return SITE_VISIT_ROOM_NAMES.some((roomName) =>
    Boolean(roomContent(roomName, roomContents, legacyContent)),
  );
}

export function buildSiteVisitMessageContent({
  roomName,
  roomContents,
  legacyContent,
}: {
  roomName: string;
  roomContents: SiteVisitRoomMessageContents;
  legacyContent: string;
}) {
  const selectedRooms = parseSiteVisitRoomNames(roomName);
  const missingRooms: CleaningRoomName[] = [];
  const parts: string[] = [];

  for (const selectedRoom of selectedRooms) {
    const content = roomContent(selectedRoom, roomContents, legacyContent);
    if (!content) {
      missingRooms.push(selectedRoom);
      continue;
    }
    parts.push(content);
  }

  return {
    content: parts.join("\n\n"),
    missingRooms,
    selectedRooms,
  };
}
