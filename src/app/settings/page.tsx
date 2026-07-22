import SettingsView from "./SettingsView";
import { getSolapiServiceStatus } from "@/lib/solapi-status";
import { getMessageTemplates } from "@/lib/message-templates";
import { getProxySellerStatus } from "@/lib/proxy-seller";
import { getProxyPayments } from "@/lib/proxy-payments";
import { getGooglePeopleStatus } from "@/lib/google-people";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [solapiStatus, messageTemplates, proxyStatus, proxyPayments, googlePeopleStatus] = await Promise.all([
    getSolapiServiceStatus(),
    getMessageTemplates(),
    getProxySellerStatus(),
    getProxyPayments(),
    getGooglePeopleStatus(),
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
      initialGooglePeopleStatus={googlePeopleStatus}
    />
  );
}
