import { it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sshFixture } from "./fixtures/ssh-server";
import { Sessions } from "../src/main/ssh";
import { Store } from "../src/main/store";
import { hostSchema, type Secret } from "../src/shared/model";
const secret: Secret = {
  type: "password",
  password: "test-only-password",
  privateKey: "",
  passphrase: "",
};
it.skipIf(process.platform !== "darwin").each(["bash", "zsh"] as const)(
  "restores an actual %s directory through SSH exec, runs startup once and cleans its temporary loader",
  async (shell) => {
    const dir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "passport-ssh-resume-")),
      ),
      project = path.join(dir, "한글 ' project");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(dir, shell === "bash" ? ".bash_profile" : ".zshrc"),
      "export PASSPORT_PROFILE_CHECK=preserved\n",
    );
    const server = await sshFixture(dir, undefined, {
      bracketedPaste: true,
      resumeShell: shell,
    });
    const store = new Store(path.join(dir, "db"), {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    });
    const host = hostSchema.parse({
      id: randomUUID(),
      name: "resume",
      address: "127.0.0.1",
      port: server.port,
      username: "tester",
      autoReconnect: true,
    });
    let output = "",
      cwd = "",
      previous = project;
    const notices: string[] = [];
    const sessions = new Sessions(
      store,
      async () => true,
      (event) => {
        if (event.kind === "output") {
          output += event.data;
          sessions.ack(event.id, event.bytes);
        }
      },
      undefined,
      {
        enabled: () => true,
        begin: () => {},
        previousCwd: () => previous,
        cwd: (_id, value) => {
          cwd = value;
        },
        notice: (_id, message) => notices.push(message),
      },
    );
    try {
      await sessions.open("pane", host, secret, "printf 'START_%s\\n' ONCE");
      await expect.poll(() => cwd).toBe(project);
      await expect.poll(() => output).toContain("START_ONCE");
      expect(
        server.input.filter((value) => value.includes("START_%s")),
      ).toHaveLength(1);
      expect(notices).toEqual([]);
      await expect
        .poll(async () =>
          (await fs.readdir(dir)).filter((name) =>
            name.startsWith("passport-session."),
          ),
        )
        .toEqual([]);
      sessions.sessions.get("pane")!.stream!.close();
      await expect.poll(() => sessions.sessions.get("pane")?.attempts).toBe(1);
      await expect
        .poll(() => sessions.sessions.get("pane")?.status, { timeout: 5000 })
        .toBe("connected");
      await expect
        .poll(async () =>
          (await fs.readdir(dir)).filter((name) =>
            name.startsWith("passport-session."),
          ),
        )
        .toEqual([]);
      expect(
        server.input.filter((value) => value.includes("START_%s")),
      ).toHaveLength(1);
      sessions.close("pane");
      previous = path.join(dir, "deleted");
      output = "";
      await sessions.open("pane", host, secret);
      await expect.poll(() => notices.join(" ")).toContain("이전 작업 폴더");
      sessions.input(
        "pane",
        "printf 'PROFILE_%s\\n' \"$PASSPORT_PROFILE_CHECK\"\r",
      );
      await expect.poll(() => output).toContain("PROFILE_preserved");
    } finally {
      sessions.closeAll();
      await server.close();
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
it("falls back to the ordinary SSH shell when the server does not support cwd integration", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-ssh-resume-fallback-"),
  );
  const server = await sshFixture(dir),
    notices: string[] = [];
  const store = new Store(path.join(dir, "db"), {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  const host = hostSchema.parse({
    id: randomUUID(),
    name: "fallback",
    address: "127.0.0.1",
    port: server.port,
    username: "tester",
  });
  const sessions = new Sessions(
    store,
    async () => true,
    (event) => {
      if (event.kind === "output") sessions.ack(event.id, event.bytes);
    },
    undefined,
    {
      enabled: () => true,
      begin: () => {},
      previousCwd: () => "/old",
      cwd: () => {},
      notice: (_id, message) => notices.push(message),
    },
  );
  try {
    await sessions.open("pane", host, secret);
    expect(sessions.sessions.get("pane")?.status).toBe("connected");
    expect(notices.join(" ")).toContain("지원하지 않습니다");
    expect(server.shells).toHaveLength(1);
  } finally {
    sessions.closeAll();
    await server.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
