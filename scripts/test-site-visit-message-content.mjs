import {
  buildSiteVisitMessageContent,
  hasAnySiteVisitMessageContent,
} from "../src/lib/site-visit-message-content.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const roomContents = {
  머무룸1: "머무룸1 안내",
  머무룸2: "머무룸2 안내",
  머무룸3: "머무룸3 안내",
};

const singleRoom = buildSiteVisitMessageContent({
  roomName: "머무룸2",
  roomContents,
  legacyContent: "",
});
assert(singleRoom.content === "머무룸2 안내", "single-room site visit must use only its room template");
assert(singleRoom.missingRooms.length === 0, "single-room template should be complete");

const multipleRooms = buildSiteVisitMessageContent({
  roomName: "머무룸1,머무룸3",
  roomContents,
  legacyContent: "",
});
assert(
  multipleRooms.content === "머무룸1 안내\n\n머무룸3 안내",
  "multi-room site visit must combine selected room templates in room order",
);

const missingRoom = buildSiteVisitMessageContent({
  roomName: "머무룸1,머무룸2",
  roomContents: { ...roomContents, 머무룸2: "" },
  legacyContent: "머무룸1 안내",
});
assert(missingRoom.missingRooms.join(",") === "머무룸2", "explicitly blank room template must not use fallback");
assert(hasAnySiteVisitMessageContent(roomContents, ""), "configured room templates must be detected");

console.log("Site visit room message content tests passed.");
