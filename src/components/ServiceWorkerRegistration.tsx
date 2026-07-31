"use client";

import { useEffect } from "react";

const SERVICE_WORKER_URL = "/sw.js?v=20260731-1";
const RELOAD_MARKER = "memoroom-sw-reloaded-20260731-1";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const handleControllerChange = () => {
      if (sessionStorage.getItem(RELOAD_MARKER)) return;
      sessionStorage.setItem(RELOAD_MARKER, "1");
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: "/",
      updateViaCache: "none",
    }).then((registration) => registration.update()).catch((error) => {
      console.error("Service worker registration failed", error);
    });

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
    };
  }, []);

  return null;
}
