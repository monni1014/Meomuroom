import MessagesView from "./MessagesView";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const [newestMessages, devices] = await Promise.all([
    prisma.customerMessage.findMany({
      orderBy: { occurredAt: "desc" },
      take: 1000,
      include: {
        reservation: {
          select: {
            id: true,
            customerName: true,
            roomName: true,
            startTime: true,
            endTime: true,
            status: true,
          },
        },
        bridgeDevice: {
          select: { name: true },
        },
      },
    }),
    prisma.smsBridgeDevice.findMany({ orderBy: { createdAt: "asc" } }),
  ]);

  const messages = newestMessages.reverse().map((message) => ({
    id: message.id,
    direction: message.direction,
    channel: message.channel,
    status: message.status,
    senderNumber: message.senderNumber,
    recipientNumber: message.recipientNumber,
    customerPhone: message.customerPhone,
    body: message.body,
    occurredAt: message.occurredAt.toISOString(),
    readAt: message.readAt?.toISOString() || null,
    bridgeDeviceName: message.bridgeDevice?.name || null,
    reservation: message.reservation
      ? {
          ...message.reservation,
          startTime: message.reservation.startTime.toISOString(),
          endTime: message.reservation.endTime.toISOString(),
        }
      : null,
  }));

  return (
    <MessagesView
      initialMessages={messages}
      devices={devices.map((device) => ({
        id: device.id,
        name: device.name,
        phoneNumber: device.phoneNumber,
        enabled: device.enabled,
        connected: Boolean(device.externalDeviceId),
        lastSeenAt: device.lastSeenAt?.toISOString() || null,
      }))}
    />
  );
}
