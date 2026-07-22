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
    database: ServerServiceStatus & { responseMs: number | null };
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
  warnings: string[];
};
