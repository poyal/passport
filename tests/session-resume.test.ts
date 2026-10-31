import { it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Store } from "../src/main/store";
import { SessionResume } from "../src/main/session-resume";
import {
  resumeArguments,
  agentResumeCommand,
  agentResumeProblem,
} from "../src/main/agent-resume";
import { ResumeOutput, remoteResumeFiles } from "../src/main/ssh-resume";
import { LOCAL_HOST_ID } from "../src/shared/advanced";
import type { AppEvent } from "../src/shared/model";
import type { ResumeScreen } from "../src/shared/session-resume";
import { resumeUntrackedMessage } from "../src/shared/session-resume";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "passport-resume-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function fixture() {
  const directory = temp();
  // Reversible test codec, deliberately distinct from real Keychain/DPAPI.
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) =>
      Buffer.from(Buffer.from(s).toString("base64")),
    decryptString: (b: Buffer) =>
      Buffer.from(b.toString(), "base64").toString(),
  };
  const store = new Store(directory, vault);
  cleanup.push(() => store.close());
  const document = store.read(),
    id = randomUUID();
  document.settings.sessionResume = true;
  document.workspaces = [
    {
      id: randomUUID(),
      name: "Resume",
      root: {
        id,
        kind: "pane",
        hostId: LOCAL_HOST_ID,
        local: { shell: "bash", cwd: directory },
      },
    },
  ];
  store.save(document);
  const events: AppEvent[] = [];
  const transport = {
    owner: () => 1,
    send: (_: number, event: AppEvent) => {
      events.push(event);
    },
    notice: () => {},
  };
  const resume = new SessionResume(store, transport);
  cleanup.push(() => resume.close());
  const generation = randomUUID();
  resume.begin(id, generation);
  return {
    directory,
    store,
    document,
    id,
    events,
    transport,
    resume,
    generation,
    vault,
  };
}
const screen = (id: string, data = "old output"): ResumeScreen => ({
  id,
  data,
  cols: 80,
  rows: 24,
  unicodeWidth: "unicode11",
});
function capture(f: ReturnType<typeof fixture>, data = "old output") {
  const promise = f.resume.checkpoint(f.id);
  const event = f.events.at(-1)!;
  if (event.kind !== "resume-checkpoint") throw new Error("missing checkpoint");
  f.resume.reply(1, event.token, screen(f.id, data));
  return promise;
}
it("preserves explicit Codex policies and config while replacing selectors and excluding initial input", () => {
  const parsed = resumeArguments("codex", [
    "-a",
    "never",
    "-s",
    "danger-full-access",
    "-c",
    'model_reasoning_effort="high"',
    "resume",
    "--last",
    "--all",
    "old-id",
    "do not repeat",
    "--image=once.png",
  ]);
  expect(parsed).toEqual({
    args: [
      "-a",
      "never",
      "-s",
      "danger-full-access",
      "-c",
      'model_reasoning_effort="high"',
    ],
  });
  expect(
    agentResumeCommand({
      agent: "codex",
      ...parsed,
      cwd: "/project",
      session: "exact-id",
      running: true,
    }),
  ).toEqual([...parsed.args, "resume", "exact-id", "--cd", "/project"]);
  expect(resumeArguments("codex", [])).toEqual({ args: [] });
  for (const args of [
    ["--remote", "ws://localhost"],
    ["--worktree"],
    ["exec", "task"],
    ["--unknown", "value"],
  ])
    expect(resumeArguments("codex", args).reason).toBeTruthy();
  expect(
    resumeArguments("claude", [
      "--model",
      "sonnet",
      "--permission-mode",
      "plan",
      "--resume",
      "old",
      "initial prompt",
    ]).args,
  ).toEqual(["--model", "sonnet", "--permission-mode", "plan"]);
});
it("persists each pane's native ID and encrypted argv, retains shutdown eligibility, and clears explicit exits", () => {
  const f = fixture();
  const base = {
    source: "codex" as const,
    generation: f.generation,
    agentRun: "one",
  };
  f.resume.agentEvent(f.id, {
    ...base,
    event: "run-start",
    cwd: f.directory,
    args: ["-a", "never", "-s", "danger-full-access"],
  });
  f.resume.agentEvent(f.id, {
    ...base,
    event: "session-start",
    session: "first",
  });
  f.resume.agentEvent(f.id, {
    ...base,
    event: "session-start",
    session: "selected",
  });
  f.resume.agentEvent(f.id, {
    ...base,
    event: "session-start",
    session: "--dangerously-bypass-approvals-and-sandbox",
  });
  f.resume.agentEvent(f.id, {
    ...base,
    agentRun: "nested",
    event: "session-start",
    session: "wrong",
  });
  expect(f.resume.get(f.id)?.agent?.session).toBe("selected");
  const row = f.store.db
    .prepare("SELECT value,agent FROM session_resume WHERE id=?")
    .get(f.id) as { value: string; agent: Buffer };
  expect(row.value).not.toContain("danger-full-access");
  expect(row.agent.toString()).not.toContain("danger-full-access");
  f.resume.stop(f.id, true);
  f.resume.agentEvent(f.id, { ...base, event: "run-end" });
  expect(f.resume.get(f.id)?.agent?.running).toBe(true);
  f.resume.begin(f.id, f.generation);
  f.resume.agentEvent(f.id, {
    ...base,
    event: "run-start",
    cwd: f.directory,
    args: [],
  });
  f.resume.agentEvent(f.id, {
    ...base,
    event: "session-start",
    session: "new",
  });
  f.resume.agentEvent(f.id, { ...base, event: "run-end" });
  expect(f.resume.get(f.id)?.agent?.running).toBe(false);
  expect(agentResumeCommand(f.resume.get(f.id)!.agent!)).toBeUndefined();
});
it("retains a confirmed conversation across exact native resumes without SessionStart and clears unrelated runs", () => {
  const f = fixture();
  const base = {
    source: "codex" as const,
    generation: f.generation,
    agentRun: "initial",
  };
  f.resume.agentEvent(f.id, {
    ...base,
    event: "run-start",
    cwd: f.directory,
    home: "/fixture-home",
    args: ["-a", "never"],
  });
  f.resume.agentEvent(f.id, {
    ...base,
    event: "turn-start",
    session: "confirmed",
    transcript: "/fixture-transcript",
  });
  const original = f.resume.get(f.id)!.agent!;
  for (let i = 0; i < 2; i++) {
    f.resume.stop(f.id, true);
    f.resume.begin(f.id, f.generation);
    f.resume.agentEvent(f.id, {
      ...base,
      agentRun: `resumed-${i}`,
      event: "run-start",
      cwd: f.directory,
      home: "/fixture-home",
      args: agentResumeCommand(original),
    });
    expect(f.resume.get(f.id)?.agent).toEqual(original);
  }
  for (const change of [
    { args: ["-a", "never"] },
    { args: ["-a", "never", "resume", "different", "--cd", f.directory] },
    { home: "/different-home" },
    { cwd: "/different-directory" },
  ]) {
    // Establish the original with an authoritative hook before each mismatch.
    f.resume.stop(f.id, true);
    f.resume.begin(f.id, f.generation);
    f.resume.agentEvent(f.id, {
      ...base,
      event: "run-start",
      cwd: f.directory,
      home: "/fixture-home",
      args: original.args,
    });
    f.resume.agentEvent(f.id, {
      ...base,
      event: "turn-start",
      session: "confirmed",
    });
    f.resume.stop(f.id, true);
    f.resume.begin(f.id, f.generation);
    f.resume.agentEvent(f.id, {
      ...base,
      agentRun: "different",
      event: "run-start",
      cwd: f.directory,
      home: "/fixture-home",
      args: agentResumeCommand(original),
      ...change,
    });
    expect(f.resume.get(f.id)?.agent?.session).toBeUndefined();
  }
});
it("retains history across app reopen and rejects stale owners, generations, and writes after disabling", async () => {
  const f = fixture();
  await capture(f);
  const reopened = new SessionResume(f.store, f.transport);
  cleanup.push(() => reopened.close());
  await reopened.checkpoint(f.id); // no live renderer: must not overwrite with an empty xterm
  expect(reopened.get(f.id)?.screen?.data).toBe("old output");
  const pending = f.resume.checkpoint(f.id),
    event = f.events.at(-1)!;
  if (event.kind !== "resume-checkpoint") throw new Error();
  f.resume.reply(2, event.token, screen(f.id, "wrong window"));
  expect(f.resume.get(f.id)?.screen?.data).toBe("old output");
  f.document.settings.sessionResume = false;
  f.resume.configure(f.document);
  f.resume.reply(1, event.token, screen(f.id, "late"));
  await pending;
  expect(f.store.db.prepare("SELECT * FROM session_resume").all()).toEqual([]);
  f.document.settings.sessionResume = true;
  f.resume.configure(f.document);
  expect(f.resume.summaries()).toEqual([]);
});
it("records why an existing unintegrated terminal restores only history and clears it after integration", async () => {
  const f = fixture();
  f.resume.begin(f.id, f.generation, false);
  expect(f.resume.needsReconnect(f.id)).toBe(true);
  f.resume.agentEvent(f.id, {
    source: "codex",
    generation: f.generation,
    event: "run-start",
    agentRun: "untracked",
    cwd: f.directory,
    args: [],
  });
  expect(f.resume.get(f.id)?.agent).toBeUndefined();
  await capture(f);
  const reopened = new SessionResume(f.store, f.transport);
  cleanup.push(() => reopened.close());
  expect(reopened.get(f.id)?.reason).toBe(resumeUntrackedMessage);
  expect(reopened.get(f.id)?.screen?.data).toBe("old output");
  reopened.begin(f.id, randomUUID());
  expect(reopened.needsReconnect(f.id)).toBe(false);
  reopened.cwd(f.id, f.directory);
  expect(reopened.get(f.id)?.reason).toBeUndefined();
});
it("reopens empty native sessions without resume and resumes only conversations that actually started", async () => {
  const f = fixture();
  const base = {
    source: "claude" as const,
    generation: f.generation,
    agentRun: "claude",
  };
  f.resume.agentEvent(f.id, {
    ...base,
    event: "run-start",
    cwd: f.directory,
    args: ["--permission-mode", "plan"],
  });
  const transcript = path.join(f.directory, "conversation.jsonl");
  f.resume.agentEvent(f.id, {
    ...base,
    event: "session-start",
    session: "empty",
    sessionSource: "startup",
    transcript,
  });
  expect(f.resume.get(f.id)?.agent?.hasConversation).toBe(false);
  expect(agentResumeCommand(f.resume.get(f.id)!.agent!)).toEqual([
    "--permission-mode",
    "plan",
  ]);
  expect(await agentResumeProblem(f.resume.get(f.id)!.agent!)).toBeUndefined();
  f.resume.agentEvent(f.id, {
    ...base,
    event: "turn-start",
    session: "empty",
    transcript,
  });
  expect(agentResumeCommand(f.resume.get(f.id)!.agent!)).toEqual([
    "--permission-mode",
    "plan",
    "--resume",
    "empty",
  ]);
  expect(await agentResumeProblem(f.resume.get(f.id)!.agent!)).toContain(
    "대화 파일",
  );
  fs.writeFileSync(transcript, '{"type":"user"}\n');
  expect(await agentResumeProblem(f.resume.get(f.id)!.agent!)).toBeUndefined();
  f.resume.agentEvent(f.id, {
    ...base,
    event: "session-start",
    session: "empty",
    sessionSource: "startup",
    transcript,
  });
  expect(f.resume.get(f.id)?.agent?.hasConversation).toBe(true);
  f.resume.agentEvent(f.id, {
    ...base,
    event: "session-start",
    session: "cleared",
    sessionSource: "clear",
    transcript: path.join(f.directory, "cleared.jsonl"),
  });
  expect(f.resume.get(f.id)?.agent?.hasConversation).toBe(false);
  f.resume.agentEvent(f.id, {
    ...base,
    event: "session-start",
    session: "existing",
    sessionSource: "resume",
    transcript,
  });
  expect(f.resume.get(f.id)?.agent?.hasConversation).toBe(true);
  f.resume.agentEvent(f.id, {
    ...base,
    event: "session-start",
    session: "another-empty",
    sessionSource: "startup",
    transcript,
  });
  f.resume.agentEvent(f.id, {
    ...base,
    event: "stop-candidate",
    session: "another-empty",
    transcript,
  });
  expect(f.resume.get(f.id)?.agent?.hasConversation).toBe(true);
});
it("invalidates replaced targets and keeps SSH paths bound to the verified fingerprint", () => {
  const f = fixture();
  f.resume.sshCwd(f.id, "first");
  f.resume.cwd(f.id, "/old");
  const group = randomUUID();
  f.resume.logGroup(f.id, group);
  expect(f.resume.sshCwd(f.id, "first")).toBe("/old");
  expect(f.resume.get(f.id)?.logGroup).toBe(group);
  expect(f.resume.sshCwd(f.id, "changed")).toBeUndefined();
  expect(f.resume.get(f.id)?.cwd).toBeUndefined();
  expect(f.resume.get(f.id)?.logGroup).toBeUndefined();
  f.resume.logGroup(f.id, group);
  const pane = f.document.workspaces[0].root;
  if (pane.kind !== "pane" || !pane.local) throw new Error();
  pane.local.cwd = "/different";
  f.resume.configure(f.document);
  expect(f.resume.summaries()).toEqual([]);
});
it("falls back to terminal-only restore when encrypted launch data cannot be read", () => {
  const f = fixture();
  f.resume.agentEvent(f.id, {
    source: "codex",
    generation: f.generation,
    event: "run-start",
    agentRun: "r",
    cwd: f.directory,
    args: ["-c", "secret=fixture"],
  });
  f.vault.decryptString = () => {
    throw new Error("locked");
  };
  const reopened = new SessionResume(f.store, f.transport);
  cleanup.push(() => reopened.close());
  expect(reopened.get(f.id)?.agent).toBeUndefined();
  expect(reopened.get(f.id)?.reason).toContain("복호화");
});
it("filters only connection-bound cwd metadata across every chunk boundary", () => {
  const marker = "\x1b]777;passport-cwd;nonce;/한글 folder\x1b\\";
  for (let split = 0; split <= marker.length; split++) {
    const events: string[] = [],
      parser = new ResumeOutput("nonce", (kind, value) =>
        events.push(kind + ":" + value),
      );
    expect(
      parser.push("before" + marker.slice(0, split)) +
        parser.push(marker.slice(split) + "after") +
        parser.end(),
    ).toBe("beforeafter");
    expect(events).toEqual(["cwd:/한글 folder"]);
  }
  const parser = new ResumeOutput("other", () => {
    throw new Error();
  });
  expect(parser.push(marker)).toBe(marker);
});
it.skipIf(process.platform !== "darwin")(
  "runs SSH startup scripts in isolated real Bash and zsh without changing user startup files",
  () => {
    const directory = temp(),
      project = path.join(directory, "한글 ' work"),
      home = path.join(directory, "home");
    fs.mkdirSync(project);
    fs.mkdirSync(home);
    for (const shell of ["bash", "zsh"] as const) {
      const loader = path.join(directory, shell);
      fs.mkdirSync(loader);
      const user = path.join(
        home,
        shell === "bash" ? ".bash_profile" : ".zshrc",
      );
      fs.writeFileSync(user, "export PASSPORT_FIXTURE_PROFILE=preserved\n");
      for (const [name, data] of Object.entries(
        remoteResumeFiles(shell, "nonce", project),
      ))
        fs.writeFileSync(path.join(loader, name), data);
      const result = spawnSync(
        "/bin/" + shell,
        shell === "bash"
          ? ["--rcfile", path.join(loader, "startup.bash"), "-i"]
          : ["-l", "-i"],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: home,
            ZDOTDIR: loader,
            PASSPORT_REMOTE_ZDOTDIR: home,
            PASSPORT_REMOTE_HAD_ZDOTDIR: "0",
            PASSPORT_REMOTE_LOADER: loader,
          },
          input:
            'printf "PROFILE:%s\\n" "$PASSPORT_FIXTURE_PROFILE"\npwd\nexit\n',
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("PROFILE:preserved");
      expect(result.stdout).toContain(project);
      expect(result.stdout + result.stderr).toContain("passport-ready;nonce;1");
      expect(fs.readFileSync(user, "utf8")).toBe(
        "export PASSPORT_FIXTURE_PROFILE=preserved\n",
      );
    }
  },
);
