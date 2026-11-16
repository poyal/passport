import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { UpdatePlatform } from "./platform/contracts";
import type { PreparedUpdate } from "./update-download";

export async function prepareUpdateInstall(
  update: PreparedUpdate,
  options: {
    platform: UpdatePlatform;
    executable: string;
    resources: string;
    data: string;
    current: string;
  },
) {
  const target = await fs.realpath(
    options.platform.installRoot(options.executable),
  );
  const data = await fs.realpath(options.data);
  const root = await fs.realpath(update.directory);
  const parent = path.dirname(target);
  const probe = path.join(parent, `.passport-write-${randomUUID()}`);
  try {
    const handle = await fs.open(probe, "wx", 0o600);
    await handle.close();
  } catch {
    throw new Error(
      "현재 설치 위치에 쓰기 권한이 없습니다. 사용자 소유 폴더에 Passport를 설치해 주세요.",
    );
  } finally {
    await fs.unlink(probe).catch(() => {});
  }
  const helper = path.join(root, options.platform.helperName);
  await fs.copyFile(
    path.join(
      options.resources,
      "terminal",
      "helper",
      options.platform.target,
      options.platform.helperName,
    ),
    helper,
  );
  await fs.chmod(helper, 0o700);
  await fs.writeFile(
    path.join(root, "request.json"),
    JSON.stringify({
      target,
      data,
      current: options.current,
      version: update.version,
      pid: process.pid,
      token: randomUUID(),
    }),
    { mode: 0o600 },
  );
  // Caller invokes this only once existing close confirmations and asynchronous
  // shutdown have completed. Cancelling a window close cannot arm an update.
  return async () => {
    const child = spawn(helper, [root], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  };
}

export async function acknowledgeUpdate(
  data: string,
  transaction: string | undefined,
  token: string | undefined,
  version: string,
) {
  if (!transaction || !token) return;
  const parent = await fs.realpath(path.join(data, "updates"));
  const root = await fs.realpath(transaction);
  if (path.dirname(root) !== parent)
    throw new Error("잘못된 업데이트 경로입니다.");
  const request = JSON.parse(
    await fs.readFile(path.join(root, "request.json"), "utf8"),
  );
  if (request.token !== token || request.version !== version)
    throw new Error("업데이트 시작 확인이 일치하지 않습니다.");
  await fs.writeFile(path.join(root, "healthy"), token, { mode: 0o600 });
}

export async function previousUpdateFailure(data: string) {
  const directory = path.join(data, "updates");
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const root = path.join(directory, entry.name);
    const error = await fs
      .readFile(path.join(root, "error.txt"), "utf8")
      .catch(() => "");
    const journal = await fs
      .readFile(path.join(root, "journal.jsonl"), "utf8")
      .catch(() => "");
    if (journal.trimEnd().endsWith('{"state":"complete"}')) {
      const running = await fs.stat(path.join(root, "lock")).then(
        () => true,
        () => false,
      );
      if (!running)
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (error || journal.includes('"rolled-back"'))
      return "이전 업데이트를 완료하지 못했습니다. 현재 버전을 확인하고 다시 시도해 주세요.";
  }
}
