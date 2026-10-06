import fs from "node:fs";

// The runner owns this JSONL file; never record environment or clipboard data.
export function recordElectronLifecycle(event) {
  const file = process.env.PASSPORT_E2E_LIFECYCLE_LOG;
  if (file)
    fs.appendFileSync(
      file,
      JSON.stringify({ at: Date.now(), ...event }) + "\n",
    );
}

export function summarizeElectronLifecycle(events) {
  const count = (kind) => events.filter((event) => event.kind === kind).length;
  const audits = events.filter((event) => event.kind === "shutdown-audit");
  return {
    launches: count("launch"),
    windows: count("window"),
    exits: count("exit"),
    reusedTests: count("reuse"),
    auditedShutdowns: audits.length,
    shown: audits.reduce((sum, event) => sum + (event.shown || 0), 0),
    focused: audits.reduce((sum, event) => sum + (event.focused || 0), 0),
  };
}
