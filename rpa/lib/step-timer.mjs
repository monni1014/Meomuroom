import { performance } from "node:perf_hooks";

function token(value) {
  return encodeURIComponent(String(value ?? "").replace(/\s+/g, " ").trim());
}

export function createStepTimer(scope, baseFields = {}, now = () => performance.now()) {
  const startedAt = now();
  let previousAt = startedAt;

  return {
    mark(step, fields = {}) {
      const currentAt = now();
      const values = {
        scope,
        step,
        stepMs: Math.max(0, Math.round(currentAt - previousAt)),
        totalMs: Math.max(0, Math.round(currentAt - startedAt)),
        ...baseFields,
        ...fields,
      };
      previousAt = currentAt;
      console.log(
        `[RPA_TIMING] ${Object.entries(values)
          .map(([key, value]) => `${key}=${token(value)}`)
          .join(" ")}`,
      );
      return values;
    },
  };
}
