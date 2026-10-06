export function recordElectronLifecycle(event: Record<string, unknown>): void;
export function summarizeElectronLifecycle(events: Record<string, any>[]): {
  launches: number;
  windows: number;
  exits: number;
  reusedTests: number;
  auditedShutdowns: number;
  shown: number;
  focused: number;
};
