import "dotenv/config";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const client = new ImapFlow({
  host: "imap.naver.com",
  port: 993,
  secure: true,
  auth: {
    user: process.env.NAVER_EMAIL || "",
    pass: process.env.NAVER_EMAIL_PASSWORD || "",
  },
  logger: false,
});

function urlsFrom(subject, text, html) {
  const combined = `${subject}\n${text}\n${html || ""}`;
  return (combined.match(/https?:\/\/\S*spacecloud\S*/gi) || [])
    .map((url) => url.replace(/&amp;/g, "&").replace(/["<>]/g, ""))
    .slice(0, 8);
}

try {
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const out = [];

    for await (const msg of client.fetch({ since }, { source: true, envelope: true, uid: true })) {
      const parsed = await simpleParser(msg.source);
      const subject = parsed.subject || "";
      const text = parsed.text || "";
      const html = String(parsed.html || "");

      if (
        subject.includes("스페이스클라우드")
        || text.includes("스페이스클라우드")
        || subject.includes("호스트님")
        || html.includes("spacecloud")
      ) {
        out.push({
          uid: msg.uid,
          date: parsed.date,
          subject,
          messageId: parsed.messageId,
          urls: urlsFrom(subject, text, html),
        });
      }
    }

    console.log(JSON.stringify(out.slice(-10), null, 2));
  } finally {
    lock.release();
  }
} finally {
  await client.logout().catch(() => {});
}
