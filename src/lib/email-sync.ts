import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseEmail, ParsedReservation } from './email-parser';
import { prisma } from './prisma';
import { processNaverEmailWithRpa } from './naver-rpa-sync';

async function markEmailProcessed(messageId: string, source?: string | null, reservationId?: string | null) {
  await prisma.processedEmail.upsert({
    where: { messageId },
    update: {
      source: source || undefined,
      reservationId: reservationId || undefined,
    },
    create: {
      messageId,
      source: source || undefined,
      reservationId: reservationId || undefined,
    },
  });
}

export async function syncEmails(): Promise<{ processed: number; newReservations: number }> {
  const globalLock = globalThis as unknown as { __emailSyncRunning?: boolean };
  if (globalLock.__emailSyncRunning) {
    console.log('[EmailSync] Previous sync is still running. Skip this request.');
    return { processed: 0, newReservations: 0 };
  }
  globalLock.__emailSyncRunning = true;

  console.log('[EmailSync] 동기화 시작...');
  
  const client = new ImapFlow({
    host: 'imap.naver.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.NAVER_EMAIL || '',
      pass: process.env.NAVER_EMAIL_PASSWORD || ''
    },
    logger: false, // 로깅 끄기
    // 타임아웃 명시: 네이버가 연결을 끊거나 응답이 늦을 때 무한 대기 방지
    connectionTimeout: 15000, // 연결 수립 15초
    greetingTimeout: 10000,   // 서버 인사 10초
    socketTimeout: 30000,     // 소켓 무응답 30초
  });

  client.on('error', (err) => {
    console.error('[EmailSync] IMAP 클라이언트 에러 (타임아웃 등):', err.message);
  });

  let processed = 0;
  let newReservations = 0;

  try {
    // 1. IMAP 연결 (전체 연결 과정에도 안전장치)
    await client.connect();
    console.log('[EmailSync] IMAP 연결 성공');

    // 안 읽은 메일을 한 번에 메모리로 수집한 뒤(IMAP 점유 시간 최소화),
    // DB 처리는 연결을 들고 있지 않은 상태에서 한다.

    // === 1단계: IMAP에서 메일 본문만 빠르게 수집하고 읽음 처리 ===
    // 연결을 잡은 채 DB 작업을 하면 소켓 타임아웃으로 끊기므로,
    // 여기서는 IMAP 작업만 최소한으로 수행하고 곧바로 연결을 닫는다.
    const collected: { messageId: string; source: Buffer; uid: number }[] = [];
    const seenUids: number[] = [];

    const lock = await client.getMailboxLock('INBOX');
    try {
      console.log('[EmailSync] 최근 3일치 메일 검색 중...');
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - 3);
      const messages = client.fetch({ since: sinceDate }, { source: true, uid: true, envelope: true });

      // ⚠️ 중요: fetch 스트림을 도는 동안에는 다른 IMAP 명령(messageFlagsAdd 등)을
      // 절대 호출하지 않는다. imapflow는 명령을 직렬 처리하므로 스트림 도중 다른
      // 명령을 끼우면 데드락(소켓 타임아웃)이 발생한다. 여기서는 수집만 한다.
      for await (const message of messages) {
        processed++;
        const messageId = message.envelope?.messageId || `uid-${message.uid}`;
        if (message.source) {
          collected.push({ messageId, source: message.source, uid: message.uid });
          seenUids.push(message.uid);
        } else {
          console.log(`[EmailSync] 메일 본문 없음, 스킵: ${messageId}`);
        }
      }

      // 스트림이 끝난 뒤에 한 번에 읽음 처리 (배치)
      if (seenUids.length > 0) {
        await client.messageFlagsAdd({ uid: seenUids.join(',') }, ['\\Seen']);
      }
    } finally {
      lock.release();
    }

    // IMAP 연결을 먼저 닫는다 (이후 DB 작업은 연결과 무관)
    try {
      await client.logout();
    } catch (logoutErr) {
      console.log('[EmailSync] 로그아웃 에러 (무시):', logoutErr instanceof Error ? logoutErr.message : String(logoutErr));
    }

    // === 2단계: 수집한 메일을 DB에 반영 (IMAP 연결 없이 처리) ===
    for (const mail of collected) {
      const { messageId } = mail;
      const parsedMail = await simpleParser(mail.source);
      const subject = parsedMail.subject || '';
      const text = parsedMail.text || '';

      const processedEmail = await prisma.processedEmail.findUnique({ where: { messageId } });
      if (processedEmail) {
        console.log(`[EmailSync] Already processed email ignored: ${messageId}`);
        continue;
      }

      // 무통장입금 "입금대기(접수)" 메일은 무시한다.
      //  - 무통장입금은 ① 접수=입금대기 ② 입금완료=확정, 두 통이 오고 같은 예약이다.
      //  - 입금 전(미확정)엔 슬롯도 안 막고 등록도 안 한다. 입금되면 "확정" 메일이 따로 오므로 그때 등록.
      //  - 이렇게 해야 같은 예약이 2건 등록되는 중복도 사라진다.
      if (subject.includes('입금대기') || /결제상태\s*입금대기/.test(text)) {
        console.log(`[EmailSync] 입금대기(미확정) 메일 무시: ${subject}`);
        await markEmailProcessed(messageId, "naver");
        continue;
      }

      // 이미 등록된 메일인지 확인
      const existing = await prisma.reservation.findUnique({ where: { emailId: messageId } });
      if (existing) {
        console.log(`[EmailSync] 이미 처리된 메일 무시: ${messageId}`);
        await markEmailProcessed(messageId, existing.source, existing.id);
        continue;
      }

      const reservationData = parseEmail(subject, text, messageId);

      // Naver emails contain masked customer names and no phone number.
      // They are now only a trigger for the RPA detail workflow, not a DB source.
      // This prevents duplicates like "양*우" from email + "양진우" from RPA/detail.
      if (reservationData?.source === "naver") {
        const rpaResult = await processNaverEmailWithRpa({
          messageId,
          subject,
          text,
          html: parsedMail.html,
          parsedReservation: reservationData,
          receivedAt: parsedMail.date || new Date(),
        });
        if (rpaResult.changed) newReservations++;
        await markEmailProcessed(messageId, "naver");
        continue;
      }

      if (reservationData && reservationData.isCancelled) {
        // === 취소 메일 처리 ===
        const target = await prisma.reservation.findFirst({
          where: {
            roomName: reservationData.roomName,
            startTime: reservationData.startTime,
            customerName: reservationData.customerName,
            status: { not: "CANCELLED" },
          },
        });

        if (target) {
          const updated = await prisma.reservation.update({
            where: { id: target.id },
            data: {
              status: "CANCELLED",
              price: reservationData.refundFee ?? 0, // 취소 수수료를 매출로 반영
            },
          });
          console.log(`[EmailSync] 예약 취소 처리 완료: ${reservationData.roomName} ${reservationData.customerName} (수수료 ${reservationData.refundFee ?? 0}원)`);
          await markEmailProcessed(messageId, reservationData.source, updated.id);
          newReservations++;
        } else {
          console.log(`[EmailSync] 취소 대상 예약을 찾지 못함: ${reservationData.roomName} ${reservationData.customerName} ${reservationData.startTime.toISOString()}`);
          await markEmailProcessed(messageId, reservationData.source);
        }
        continue;
      }

      if (reservationData) {
        console.log(`[EmailSync] 예약 발견! DB 등록 중... (${reservationData.roomName}, ${reservationData.source})`);
        
        // 블랙리스트(정리불량) 체크
        let autoCleanUpBad = false;
        if (reservationData.customerName) {
          const badRecord = await prisma.reservation.findFirst({
            where: {
              customerName: reservationData.customerName,
              isCleanUpBad: true,
            }
          });
          if (badRecord) {
            autoCleanUpBad = true;
          }
        }

        const created = await prisma.reservation.create({
          data: {
            source: reservationData.source,
            roomName: reservationData.roomName,
            customerName: reservationData.customerName,
            startTime: reservationData.startTime,
            endTime: reservationData.endTime,
            price: reservationData.price,
            discount: reservationData.discount ?? 0,
            isCleanUpBad: autoCleanUpBad,
            emailId: reservationData.emailId,
            createdAt: parsedMail.date || new Date(),
            usageLog: {
              create: {
                // 실제 인원은 처음엔 예약 인원과 동일하게 두고, CCTV 관찰 후 이용현황에서 조정
                headCount: reservationData.headCount,
                reservedHeadCount: reservationData.headCount,
                // 대분류는 CCTV로 실제 이용을 관찰한 뒤 이용현황에서 입력 (그 전까진 미입력)
                purpose: null,
              }
            }
          }
        });
        await markEmailProcessed(messageId, reservationData.source, created.id);
        newReservations++;
      } else {
        console.log(`[EmailSync] 예약 메일이 아님 (파싱 실패): ${subject}`);
      }
    }
  } catch (err) {
    console.error('[EmailSync] 에러 발생:', err);
    // 에러 시에도 연결이 남아있지 않도록 강제 종료
    try { client.close(); } catch { /* 무시 */ }
  } finally {
    globalLock.__emailSyncRunning = false;
    console.log(`[EmailSync] 동기화 종료. 확인: ${processed}건, 등록: ${newReservations}건`);
  }

  return { processed, newReservations };
}
