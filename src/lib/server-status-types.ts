export type ServerOverallStatus = "OK" | "WARNING" | "ERROR";

export type ServerServiceStatus = {
  status: "ACTIVE" | "INACTIVE" | "UNKNOWN";
  detail: string | null;
};

export type ServerStatusSnapshot = {
  overallStatus: ServerOverallStatus;
  summary: string;
  checkedAt: string;
  hostname: string;
  services: {
    app: ServerServiceStatus;
    database: ServerServiceStatus & { responseMs: number | null; sizeBytes: number | null };
    tailscale: ServerServiceStatus & { ip: string | null };
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
    appRssBytes: number;
    appHeapUsedBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
    processes: Array<{
      key: string;
      label: string;
      processCount: number;
      rssBytes: number;
      usedPercent: number;
    }>;
    observedPeak: {
      monitoringSince: string;
      lastSampledAt: string;
      sampleCount: number;
      systemUsedBytes: number;
      systemUsedPercent: number;
      appBytes: number;
      appPercent: number;
    } | null;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
  } | null;
  cpu: {
    cores: number;
    load1: number;
    load5: number;
    load15: number;
    loadPerCorePercent: number;
  };
  uptime: {
    systemSeconds: number;
    appSeconds: number;
  };
  billing: {
    provider: "Vultr";
    planId: string;
    startedAt: string;
    hourlyCostUsd: number;
    monthlyCostUsd: number;
    currentMonthEstimatedUsd: number;
    lifetimeEstimatedUsd: number;
    estimate: true;
  };
  warnings: string[];
};
