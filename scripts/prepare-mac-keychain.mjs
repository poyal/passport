import { electron } from "./e2e-electron.mjs";
import { closeCleanly } from "../tests/fixtures/electron-exit.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// This function also runs in the candidate's main process. Keep it self-contained.
export function verifyEncryption({ safeStorage }) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("macOS Keychain encryption is unavailable");
  const probe = "Passport release Keychain preparation";
  const encrypted = safeStorage.encryptString(probe);
  if (safeStorage.decryptString(encrypted) !== probe)
    throw new Error("macOS Keychain encryption round trip failed");
  return true;
}

async function prepare(executable) {
  if (process.platform !== "darwin" || !executable)
    throw new Error("A macOS candidate executable is required");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-keychain-"),
  );
  let application, timer;
  try {
    application = await electron.launch({
      executablePath: executable,
      args: [],
      env: {
        ...process.env,
        PASSPORT_DATA_DIR: directory,
        PASSPORT_DISABLE_UPDATE_CHECK: "1",
      },
      timeout: 30000,
    });
    console.log(
      "macOS Keychain preparation: approve this candidate in the OS dialog if prompted.",
    );
    await Promise.race([
      application.evaluate(verifyEncryption),
      new Promise((_, reject) => {
        // OS authorization is a preparation step, outside GUI test deadlines.
        timer = setTimeout(
          () =>
            reject(
              new Error("macOS Keychain approval timed out after 180 seconds"),
            ),
          180000,
        );
      }),
    ]);
    clearTimeout(timer);
    await closeCleanly(application);
    application = undefined;
    console.log(
      JSON.stringify({
        macKeychain: "ready",
        encryptionRoundTrip: "passed",
        shutdown: "passed",
      }),
    );
  } finally {
    clearTimeout(timer);
    try {
      if (application) await closeCleanly(application);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  await prepare(process.argv[2]);
