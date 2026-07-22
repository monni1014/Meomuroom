self.NOTIFICATION_BADGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAACXBIWXMAAAsTAAALEwEAmpwYAAACrElEQVR4nO3WsVHzQBAF4AvI/oAaiOngpxQn6gQ6UeJSTAmkrsEBmYPHCDTGwFq2pN2927v3FWC/p5253ZSIiIiIiIiIiIiIiIioLFhvkwoFYLO2nEfItQ4AHlJhADyM2aofwGAH4C4VYsgC4FWjmEdYLc+pEABetEp5hNVyBPDfPPD1Pk9jFhUegTXtAdybh77c5X7MoMYjtLateejLXbbaZTxCW9iYBzc4OSUewS0cPE9TrZNT4hHeys7jNNU8OSWRB+BymmqenJLoAzhanqbaJ6fEKvt5CWt7i9PU4uSUaOeWinjYRjg5Jdq5pSJeNqWfnBKtzFNlvBw0TlPLk1Oi85WnC3narTlNrU9Oie7Xlkt5ey715JTofm25lLfjktPU4+SU2Hz1n8Vy2M85Tb1OTkmtA5h1mnqdnJKaB3DTaep5crY4gMPUaep9crY4gIunaY6Ts9UBiKdpjpOz5QEcz0/TXCdnywM4naY5T87WB4Dx3Mx2ckYfQI9y9C0O4B+AN+T3NmZpawDjbz0CeEc+w38/avcKM4ABgA75dJ8hWh7AINM+6NMZrR9N1iyCwn8ffL77HMAZx31wevd//b+KZM0yKHz2wend5wAExvugn/hfFcmadVDY7YM/775nLzUeQaG/D8R337uXCq+g0N0HXSm9VvMMCp190JfWaxXPoFi/Dybf/Vy9VvEOiuX74Oq7n7PXYjmCYtk+6ErvtUiuoJi3D/oovVKUoLh9H9z87pfQK0UKiuv7YNa7X0qvUEExvQ+6qL1CBYW8D/rovcIExd99sOjdL61XqKD43geL3/0Se4UKiq990NXWq46gtfYKE7TWXmGC1torTNBae4UJWmuvMEFr7RUmaK29wgSttVeYoLX2ChN0plp7ERERERERERERERERpdZ9AKtZYVyQxn4QAAAAAElFTkSuQmCC";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(self.registration.showNotification(payload.title || "머무룸", {
    body: payload.body || "문자 발송 상태가 변경되었습니다.",
    icon: "/icon-192.png",
    badge: self.NOTIFICATION_BADGE,
    tag: payload.tag || "memoroom-message-status",
    renotify: true,
    data: { url: payload.url || "/messages" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/messages", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        client.navigate(url);
        return client.focus();
      }
    }
    return clients.openWindow ? clients.openWindow(url) : undefined;
  }));
});
