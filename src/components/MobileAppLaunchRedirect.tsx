"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type StandaloneNavigator = Navigator & { standalone?: boolean };

export function MobileAppLaunchRedirect() {
  const router = useRouter();

  useEffect(() => {
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches
      || (window.navigator as StandaloneNavigator).standalone === true;
    const isPhone = window.matchMedia("(max-width: 767px)").matches;
    const isExplicitDashboard = new URLSearchParams(window.location.search).get("view") === "dashboard";

    if (isStandalone && isPhone && !isExplicitDashboard) {
      router.replace("/calendar");
    }
  }, [router]);

  return null;
}
