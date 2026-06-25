import "dotenv/config";

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

export function getProxyConfig() {
  const host = requiredEnv("IPROYAL_PROXY_HOST");
  const port = requiredEnv("IPROYAL_PROXY_PORT");
  const username = requiredEnv("IPROYAL_PROXY_USER");
  const password = requiredEnv("IPROYAL_PROXY_PASS");
  const protocol = optionalEnv("IPROYAL_PROXY_PROTOCOL", "http");

  return {
    server: `${protocol}://${host}:${port}`,
    username,
    password,
  };
}

export function getUpstreamProxyUrl() {
  const host = requiredEnv("IPROYAL_PROXY_HOST");
  const port = requiredEnv("IPROYAL_PROXY_PORT");
  const username = encodeURIComponent(requiredEnv("IPROYAL_PROXY_USER"));
  const password = encodeURIComponent(requiredEnv("IPROYAL_PROXY_PASS"));
  const protocol = optionalEnv("IPROYAL_PROXY_PROTOCOL", "http");

  return `${protocol}://${username}:${password}@${host}:${port}`;
}
