import { randomUUID } from "node:crypto";
import type { ActivityEndpoint } from "../contracts";

export function createWindowsActivityEndpoint(): ActivityEndpoint {
  return {
    address: `\\\\.\\pipe\\passport-${randomUUID()}`,
    listening() {},
    dispose() {},
  };
}
