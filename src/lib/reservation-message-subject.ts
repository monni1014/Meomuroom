export function reservationMessageSubject(roomName: string) {
  const roomNumber = roomName.match(/머무룸\s*([123])/)?.[1];
  return roomNumber ? `머무룸${roomNumber} 이용 안내` : "머무룸 이용 안내";
}
