export function reservationMessageSubject(roomName: string) {
  const roomNumber = roomName.match(/머무룸\s*([123])/)?.[1];
  if (roomNumber === "1") return "머무룸1 3층 안내";
  if (roomNumber === "2") return "머무룸2 4층 안내";
  if (roomNumber === "3") return "머무룸3 지하1층 안내";
  return "머무룸 이용 안내";
}
