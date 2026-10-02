export function e2eMode(env = process.env) {
  const mode = env.PASSPORT_E2E_MODE || "hidden";
  if (!["hidden", "passive", "desktop"].includes(mode))
    throw new Error(`Unknown PASSPORT_E2E_MODE: ${mode}`);
  return mode;
}
