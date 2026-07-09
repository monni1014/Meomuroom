import { prisma } from "@/lib/prisma";

export const DEFAULT_MESSAGE_TEMPLATES = [
  {
    roomName: "머무룸1",
    title: "머무룸1 - 3층",
    content: `머무룸1 - 3층
아이디어 공간 머무룸을 찾아주셔서 감사드립니다.
쾌적하고 편안한 이용을 위해 아래 사항을 안내드립니다.

📍입장전 꼭 ✨슬리퍼✨로 갈아신어주세요!!

❗️두개의 층으로 나뉘어져 있으니 잘 확인해주세요!!
1.층수 : 3층
2.출입 시 비밀번호 : 3030*
3.이용 후 분리수거 필수 (엘리베이터 앞)
4.퇴실 시 *메인등, 화장실등, 냉난방기* 확인
5.입퇴장시간을 지켜주세요!
**국물있는 음식(떡볶이)은 취식 불가**

-책상은 자유롭게 배치 가능.
-이동 시 바퀴는 고정해제 후 사용.
-사용 후에는 ✨원상복구✨ 필수

머무룸에서 머무시는 동안 아이디어가 가득 샘솟는 시간이 되시길 바랍니다.☘︎`,
  },
  {
    roomName: "머무룸2",
    title: "머무룸2 - 4층",
    content: `머무룸2 - 4층
아이디어 공간 머무룸을 찾아주셔서 감사드립니다.
쾌적하고 편안한 이용을 위해 아래 사항을 안내드립니다.

📍입장전 꼭 ✨슬리퍼✨로 갈아신어주세요!!

❗️두개의 층으로 나뉘어져 있으니 잘 확인해주세요!!
1.층수 : 4층
2.출입 시 비밀번호 : 4264*
3.이용 후 분리수거 필수 (엘리베이터 앞)
4.퇴실 시 *메인등, 화장실등, 냉난방기* 확인
5.입퇴장시간을 지켜주세요!
**국물있는 음식(떡볶이)은 취식 불가**

-책상은 자유롭게 배치 가능.
-이동 시 바퀴는 고정해제 후 사용.
-사용 후에는 ✨원상복구✨ 필수

머무룸에서 머무시는 동안 아이디어가 가득 샘솟는 시간이 되시길 바랍니다.☘︎`,
  },
  {
    roomName: "머무룸3",
    title: "머무룸3",
    content: "입실 전 안내사항을 확인해 주세요. 이용 시간에 맞춰 입실 부탁드립니다.",
  },
];

function roomTemplateKey(roomName: string) {
  if (roomName.includes("3")) return "머무룸3";
  if (roomName.includes("2")) return "머무룸2";
  return "머무룸1";
}

function defaultTemplate(roomName: string) {
  const key = roomTemplateKey(roomName);
  return DEFAULT_MESSAGE_TEMPLATES.find((template) => template.roomName === key) || DEFAULT_MESSAGE_TEMPLATES[0];
}

export async function ensureMessageTemplates() {
  await Promise.all(
    DEFAULT_MESSAGE_TEMPLATES.map((template) =>
      prisma.messageTemplate.upsert({
        where: { roomName: template.roomName },
        create: template,
        update: {},
      }),
    ),
  );

  return prisma.messageTemplate.findMany({
    orderBy: { roomName: "asc" },
  });
}

export async function getMessageTemplates() {
  const templates = await prisma.messageTemplate.findMany({
    orderBy: { roomName: "asc" },
  });

  if (templates.length >= DEFAULT_MESSAGE_TEMPLATES.length) return templates;
  return ensureMessageTemplates();
}

export async function getMessageTemplateForRoom(roomName: string) {
  const key = roomTemplateKey(roomName);
  const found = await prisma.messageTemplate.findUnique({
    where: { roomName: key },
  });

  if (found) return found.content;

  const fallback = defaultTemplate(roomName);
  const created = await prisma.messageTemplate.upsert({
    where: { roomName: fallback.roomName },
    create: fallback,
    update: {},
  });
  return created.content;
}

export async function updateMessageTemplate(roomName: string, content: string) {
  const fallback = defaultTemplate(roomName);
  const trimmed = content.trim();

  return prisma.messageTemplate.upsert({
    where: { roomName: fallback.roomName },
    create: {
      roomName: fallback.roomName,
      title: fallback.title,
      content: trimmed || fallback.content,
    },
    update: {
      content: trimmed || fallback.content,
    },
  });
}
