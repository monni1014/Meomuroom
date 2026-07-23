"use client";

import { useEffect } from "react";

const SERVICE_WORKER_URL = "/sw.js?v=20260723-8";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: "/",
      updateViaCache: "none",
    }).then((registration) => registration.update()).catch((error) => {
      console.error("Service worker registration failed", error);
    });
  }, []);

  return null;
}
