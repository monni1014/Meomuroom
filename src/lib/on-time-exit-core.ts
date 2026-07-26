export type OnTimeExitCoreReservation = {
  id: string;
  roomName: string;
  startTime: Date;
  endTime: Date;
};

export type OnTimeExitCoreTarget<T extends OnTimeExitCoreReservation> = {
  leader: T;
  members: T[];
  nextReservation: T;
  exitTime: Date;
};

function firstContiguousBlockEnd<T extends OnTimeExitCoreReservation>(members: T[]) {
  let endTime = members[0].endTime;

  for (const member of members.slice(1)) {
    if (member.startTime.getTime() > endTime.getTime()) break;
    if (member.endTime.getTime() > endTime.getTime()) endTime = member.endTime;
  }

  return endTime;
}

export function resolveOnTimeExitTargetsWithGroupKey<T extends OnTimeExitCoreReservation>(
  reservations: T[],
  groupKey: (reservation: T) => string | null,
) {
  const groups = new Map<string, T[]>();
  for (const reservation of reservations) {
    const key = groupKey(reservation);
    if (!key) continue;
    const members = groups.get(key) || [];
    members.push(reservation);
    groups.set(key, members);
  }
  for (const members of groups.values()) {
    members.sort((left, right) => (
      left.startTime.getTime() - right.startTime.getTime()
      || left.id.localeCompare(right.id)
    ));
  }

  const targets: OnTimeExitCoreTarget<T>[] = [];
  for (const members of groups.values()) {
    const leader = members[0];
    if (!leader) continue;

    const currentGroupKey = groupKey(leader);
    const exitTime = firstContiguousBlockEnd(members);
    const nextReservation = reservations
      .filter((candidate) => (
        candidate.roomName.trim() === leader.roomName.trim()
        && candidate.startTime.getTime() === exitTime.getTime()
        && groupKey(candidate) !== currentGroupKey
      ))
      .sort((left, right) => left.id.localeCompare(right.id))[0];

    if (!nextReservation) continue;
    targets.push({ leader, members, nextReservation, exitTime });
  }

  return targets;
}
