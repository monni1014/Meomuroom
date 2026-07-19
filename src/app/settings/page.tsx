import SettingsView from "./SettingsView";
import { getSolapiServiceStatus } from "@/lib/solapi-status";
import { getMessageTemplates } from "@/lib/message-templates";
import { getProxySellerStatus } from "@/lib/proxy-seller";
import { getProxyPayments } from "@/lib/proxy-payments";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [solapiStatus, messageTemplates, proxyStatus, proxyPayments] = await Promise.all([
    getSolapiServiceStatus(),
    getMessageTemplates(),
    getProxySellerStatus(),
    getProxyPayments(),
  ]);

  return (
    <SettingsView
      initialSolapiStatus={solapiStatus}
      initialMessageTemplates={messageTemplates.map((template) => ({
        id: template.id,
        roomName: template.roomName,
        title: template.title,
        content: template.content,
        updatedAt: template.updatedAt.toISOString(),
      }))}
      initialProxyStatus={proxyStatus}
      initialProxyPayments={proxyPayments}
    />
  );
}
