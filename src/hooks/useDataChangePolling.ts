"use client";

import { useEffect, useRef } from "react";

type DataChangePollingOptions = {
  enabled?: boolean;
  intervalMs?: number;
};

type VersionResponse = {
  version?: unknown;
};

export function useDataChangePolling(
  endpoint: string,
  onChange: () => void | Promise<void>,
  { enabled = true, intervalMs = 15_000 }: DataChangePollingOptions = {},
) {
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let inFlight = false;
    let currentVersion: string | null = null;

    const checkForChanges = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;

      inFlight = true;
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) return;

        const payload = (await response.json()) as VersionResponse;
        if (typeof payload.version !== "string") return;

        if (currentVersion === null) {
          currentVersion = payload.version;
          return;
        }

        if (payload.version !== currentVersion) {
          currentVersion = payload.version;
          await onChangeRef.current();
        }
      } catch (error) {
        console.error("Failed to check for updated screen data:", error);
      } finally {
        inFlight = false;
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void checkForChanges();
    };

    void checkForChanges();
    const timer = window.setInterval(() => void checkForChanges(), intervalMs);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled, endpoint, intervalMs]);
}
