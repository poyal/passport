import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActivityEndpoint } from "../contracts";

export function createDarwinActivityEndpoint(
  root = os.tmpdir(),
): ActivityEndpoint {
  const directory = fs.mkdtempSync(path.join(root, "passport-events-"));
  try {
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const address = path.join(directory, "events.sock");
  return {
    address,
    listening() {
      fs.chmodSync(address, 0o600);
    },
    dispose() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
