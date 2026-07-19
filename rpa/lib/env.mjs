import "dotenv/config";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isRpaExecutionAllowed() {
  return process.platform === "linux" && ENABLED_VALUES.has(
    String(process.env.RPA_EXECUTION_ENABLED || "").trim().toLowerCase(),
  );
}

export function assertRpaExecutionAllowed() {
  if (isRpaExecutionAllowed()) return;

  throw new Error(
    "RPA execution is disabled on this host. Memoroom RPA may run only on the authorized Linux server.",
  );
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

export function optionalEnv(name, fallback) {
  return process.env[name] || fallback;
}

function proxyEnv(suffix) {
  return process.env[`RPA_PROXY_${suffix}`] || process.env[`IPROYAL_PROXY_${suffix}`];
}

function requiredProxyEnv(suffix) {
  const value = proxyEnv(suffix);
  if (!value) {
    throw new Error(
      `Missing RPA_PROXY_${suffix} in .env (legacy IPROYAL_PROXY_${suffix} is also supported)`,
    );
  }
  return value;
}

export function getProxyProvider() {
  return optionalEnv(
    "RPA_PROXY_PROVIDER",
    process.env.RPA_PROXY_HOST ? "custom" : "iproyal",
  );
}

export function getProxyConfig() {
  const host = requiredProxyEnv("HOST");
  const port = requiredProxyEnv("PORT");
  const username = requiredProxyEnv("USER");
  const password = requiredProxyEnv("PASS");
  const protocol = proxyEnv("PROTOCOL") || "http";

  return {
    provider: getProxyProvider(),
    server: `${protocol}://${host}:${port}`,
    host,
    port,
    protocol,
    username,
    password,
  };
}

export function getUpstreamProxyUrl() {
  const host = requiredProxyEnv("HOST");
  const port = requiredProxyEnv("PORT");
  const username = encodeURIComponent(requiredProxyEnv("USER"));
  const password = encodeURIComponent(requiredProxyEnv("PASS"));
  const protocol = proxyEnv("PROTOCOL") || "http";

  return `${protocol}://${username}:${password}@${host}:${port}`;
}
