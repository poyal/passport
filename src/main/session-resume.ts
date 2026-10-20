import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PassportDocument, AppEvent } from "../shared/model";
import { panes } from "../shared/layout";
import { connectionHost } from "../shared/advanced";
import {
  agentResumeSchema,
  resumeScreenSchema,
  resumeScreenLimit,
  resumeTotalLimit,
  nativeSessionId,
  resumeUntrackedMessage,
  type AgentResume,
  type ResumeScreen,
} from "../shared/session-resume";
import { resumeArguments } from "./agent-resume";
import type { Store } from "./store";

const recordSchema = z.object({
  target: z.string().max(16384),
  cwd: z.string().max(4096).optional(),
  fingerprint: z.string().max(512).optional(),
  automatic: z.boolean(),
  screen: resumeScreenSchema.optional(),
  updated: z.number(),
  reason: z.string().max(512).optional(),
  logGroup: z.string().uuid().optional(),
});
type Record = z.infer<typeof recordSchema> & { agent?: AgentResume };
type Live = {
  generation: string;
  stopping: boolean;
  dirty: boolean;
  tracking: boolean;
  run?: string;
};
export type ResumeAgentEvent = {
  source: "terminal" | "codex" | "claude";
  event: string;
  generation: string;
  agentRun?: string;
  run?: string;
  session?: string;
  sessionSource?: "startup" | "resume" | "clear" | "compact";
  transcript?: string;
  cwd?: string;
  args?: string[];
  home?: string;
  detail?: string;
};
export class SessionResume {
  enabled = false;
  private epoch = 0;
  private records = new Map<string, Record>();
  private targets = new Map<string, string>();
  private live = new Map<string, Live>();
  private pending = new Map<
    string,
    {
      id: string;
      owner: number;
      epoch: number;
      generation?: string;
      kind: "save" | "hydrate";
      done: (screen?: ResumeScreen) => void;
    }
  >();
  private timer: ReturnType<typeof setInterval>;
  private checkpoints = new Map<string, Promise<void>>();
  private warned = new Set<string>();
  constructor(
    private store: Store,
    private transport: {
      owner: (id: string) => number | undefined;
      send: (owner: number, event: AppEvent) => void;
      notice: (id: string, message: string) => void;
    },
  ) {
    for (const row of store.db
      .prepare("SELECT id,value,agent FROM session_resume")
      .all() as { id: string; value: string; agent: Buffer | null }[]) {
      try {
        const record: Record = recordSchema.parse(JSON.parse(row.value));
        if (row.agent) {
          try {
            record.agent = agentResumeSchema.parse(
              JSON.parse(store.vault.decryptString(row.agent)),
            );
          } catch {
            record.reason =
              "AI 실행 옵션을 복호화하지 못해 자동 재개를 생략했습니다.";
          }
        }
        this.records.set(row.id, record);
      } catch {
        store.db.prepare("DELETE FROM session_resume WHERE id=?").run(row.id);
      }
    }
    this.configure(store.read());
    this.timer = setInterval(() => {
      for (const [id, live] of this.live)
        if (live.dirty) void this.checkpoint(id);
    }, 5000);
    this.timer.unref();
  }
  private send(owner: number, event: AppEvent) {
    try {
      this.transport.send(owner, event);
    } catch {
      /* The renderer may close while its checkpoint is pending. */
    }
  }
  configure(document: PassportDocument) {
    const enabled = document.settings.sessionResume;
    this.targets.clear();
    for (const pane of document.workspaces.flatMap((w) => panes(w.root))) {
      if (pane.local) {
        if (!pane.local.needsReview)
          this.targets.set(
            pane.id,
            JSON.stringify([
              "local",
              pane.local,
              document.settings.terminal.shell,
              document.settings.terminal.cwd,
            ]),
          );
      } else {
        const host = document.hosts.find((h) => h.id === pane.hostId);
        if (host) {
          const h = connectionHost(document, host, this.store.profiles());
          this.targets.set(
            pane.id,
            JSON.stringify(["ssh", h.id, h.address, h.port, h.username]),
          );
        }
      }
    }
    if (this.enabled !== enabled) {
      this.epoch++;
      this.enabled = enabled;
      for (const [token, request] of [...this.pending]) {
        this.send(request.owner, { kind: "resume-cancel", token });
        request.done();
      }
      this.live.clear();
    }
    for (const [id, record] of this.records)
      if (!enabled || record.target !== this.targets.get(id)) this.forget(id);
    if (!enabled) this.store.db.prepare("DELETE FROM session_resume").run();
  }
  forget(id: string) {
    this.records.delete(id);
    this.live.delete(id);
    for (const [token, request] of [...this.pending])
      if (request.id === id) {
        this.send(request.owner, { kind: "resume-cancel", token });
        request.done();
      }
    this.store.db.prepare("DELETE FROM session_resume WHERE id=?").run(id);
  }
  summaries() {
    return this.enabled
      ? [...this.records].map(([id, r]) => ({ id, automatic: r.automatic }))
      : [];
  }
  get(id: string) {
    return this.enabled ? this.records.get(id) : undefined;
  }
  logGroup(id: string, group: string) {
    const record = this.get(id);
    if (!record || record.logGroup === group) return;
    record.logGroup = group;
    this.persist(id);
  }
  begin(id: string, generation: string, tracking = true) {
    if (!this.enabled || !this.targets.has(id)) return;
    const old = this.records.get(id);
    this.records.set(
      id,
      old ?? {
        target: this.targets.get(id)!,
        automatic: true,
        updated: Date.now(),
      },
    );
    this.live.set(id, { generation, stopping: false, dirty: false, tracking });
    this.records.get(id)!.automatic = true;
    if (!tracking) this.records.get(id)!.reason = resumeUntrackedMessage;
    this.persist(id);
  }
  needsReconnect(id: string) {
    const live = this.live.get(id);
    return this.enabled && !!live && !live.tracking;
  }
  generation(id: string) {
    return this.live.get(id)?.generation;
  }
  stop(id: string, automatic: boolean) {
    const live = this.live.get(id);
    if (live) live.stopping = true;
    const record = this.get(id);
    if (record) {
      record.automatic = automatic;
      this.persist(id);
    }
  }
  dirty(id: string) {
    const live = this.live.get(id);
    if (live) live.dirty = true;
  }
  cwd(id: string, cwd: string) {
    if (!cwd || cwd.length > 4096 || /[\0\r\n\x1b]/.test(cwd)) return;
    const record = this.get(id),
      live = this.live.get(id);
    if (
      !record ||
      !live ||
      !live.tracking ||
      live.stopping ||
      record.cwd === cwd
    )
      return;
    record.cwd = cwd;
    if (record.reason === resumeUntrackedMessage) record.reason = undefined;
    this.persist(id);
  }
  sshCwd(id: string, fingerprint: string | undefined) {
    const record = this.get(id);
    if (!record) return;
    const cwd =
      record.fingerprint && record.fingerprint === fingerprint
        ? record.cwd
        : undefined;
    if (record.fingerprint !== fingerprint) {
      if (record.fingerprint) {
        record.screen = undefined;
        record.logGroup = undefined;
      }
      record.cwd = undefined;
      record.fingerprint = fingerprint;
      this.persist(id);
    }
    return cwd;
  }
  agentEvent(id: string, event: ResumeAgentEvent) {
    const live = this.live.get(id),
      record = this.get(id);
    if (
      !live ||
      !record ||
      !live.tracking ||
      live.stopping ||
      live.generation !== event.generation
    )
      return;
    if (event.source === "terminal") {
      if (event.event === "cwd" && event.cwd) this.cwd(id, event.cwd);
      return;
    }
    const run = event.agentRun || event.run;
    if (event.event === "run-start") {
      if (!run || !event.cwd) return;
      // Nested/background wrappers must not replace the foreground binding.
      if (live.run && record.agent?.running) return;
      live.run = run;
      const parsed = event.args
        ? resumeArguments(event.source, event.args)
        : { args: [], reason: "실행 옵션을 확인하지 못했습니다." };
      record.agent = {
        agent: event.source,
        cwd: event.cwd,
        home: event.home,
        running: true,
        ...parsed,
      };
      record.reason = parsed.reason;
    } else if (run && live.run === run && record.agent) {
      if (event.event === "run-end") {
        record.agent.running = false;
        live.run = undefined;
      } else if (
        event.session &&
        nativeSessionId.test(event.session) &&
        ["session-start", "turn-start", "completed", "stop-candidate"].includes(
          event.event,
        )
      ) {
        if (record.agent.session !== event.session) {
          record.agent.hasConversation = undefined;
          record.agent.transcript = undefined;
        }
        record.agent.session = event.session;
        if (event.transcript && !/[\0\r\n\x1b]/.test(event.transcript))
          record.agent.transcript = event.transcript;
        if (
          event.event !== "session-start" ||
          ["resume", "compact"].includes(event.sessionSource || "")
        )
          record.agent.hasConversation = true;
        else if (
          ["startup", "clear"].includes(event.sessionSource || "") &&
          record.agent.hasConversation !== true
        )
          record.agent.hasConversation = false;
        if (event.cwd && !/[\0\r\n\x1b]/.test(event.cwd))
          record.agent.cwd = event.cwd;
      }
    } else return;
    this.persist(id);
  }
  private persist(id: string) {
    const record = this.get(id);
    if (!record) return;
    const { agent, ...value } = record;
    let encrypted: Buffer | null = null;
    if (agent) {
      try {
        if (!this.store.vault.isEncryptionAvailable()) throw new Error();
        encrypted = this.store.vault.encryptString(JSON.stringify(agent));
      } catch {
        value.reason =
          "암호화 저장소를 사용할 수 없어 앱 재실행 후 AI 자동 재개를 생략합니다.";
      }
    }
    try {
      this.store.db
        .prepare(
          "INSERT INTO session_resume(id,value,agent) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,agent=excluded.agent",
        )
        .run(id, JSON.stringify(value), encrypted);
      this.warned.delete(id);
    } catch {
      if (!this.warned.has(id)) {
        this.warned.add(id);
        this.transport.notice(
          id,
          "세션 복원 데이터를 저장하지 못했습니다. 저장 공간과 앱 데이터 폴더 권한을 확인하세요.",
        );
      }
    }
  }
  private request(id: string, kind: "save" | "hydrate", screen?: ResumeScreen) {
    const owner = this.transport.owner(id);
    if (!this.enabled || owner === undefined)
      return Promise.resolve<ResumeScreen | undefined>(undefined);
    const token = randomUUID(),
      epoch = this.epoch,
      generation = this.live.get(id)?.generation;
    return new Promise<ResumeScreen | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.send(owner, { kind: "resume-cancel", token });
        done();
      }, 1000);
      const done = (result?: ResumeScreen) => {
        clearTimeout(timer);
        this.pending.delete(token);
        resolve(result);
      };
      this.pending.set(token, { id, owner, epoch, generation, kind, done });
      this.send(
        owner,
        kind === "save"
          ? { kind: "resume-checkpoint", id, token }
          : { kind: "resume-hydrate", id, token, screen: screen! },
      );
    });
  }
  reply(owner: number, token: string, screen?: ResumeScreen) {
    const p = this.pending.get(token);
    if (!p || p.owner !== owner || this.transport.owner(p.id) !== owner) return;
    if (
      !this.enabled ||
      p.epoch !== this.epoch ||
      p.generation !== this.live.get(p.id)?.generation
    ) {
      p.done();
      return;
    }
    if (
      p.kind === "save" &&
      screen?.id === p.id &&
      Buffer.byteLength(screen.data) <= resumeScreenLimit
    )
      p.done(screen);
    else if (p.kind === "hydrate") p.done(this.get(p.id)?.screen);
    else p.done();
  }
  checkpoint(id: string): Promise<void> {
    const existing = this.checkpoints.get(id);
    if (existing) return existing;
    const work = this.saveCheckpoint(id).finally(() => {
      if (this.checkpoints.get(id) === work) this.checkpoints.delete(id);
    });
    this.checkpoints.set(id, work);
    return work;
  }
  private async saveCheckpoint(id: string) {
    if (
      !this.get(id) ||
      !this.live.has(id) ||
      [...this.pending.values()].some((p) => p.id === id && p.kind === "save")
    )
      return;
    const live = this.live.get(id),
      epoch = this.epoch;
    if (live) live.dirty = false;
    const screen = await this.request(id, "save");
    const record = this.get(id);
    if (
      !screen ||
      !record ||
      epoch !== this.epoch ||
      this.live.get(id) !== live
    ) {
      if (live) live.dirty = true;
      return;
    }
    record.screen = screen;
    record.updated = Date.now();
    this.persist(id);
    let size = [...this.records.values()].reduce(
      (n, r) => n + Buffer.byteLength(r.screen?.data || ""),
      0,
    );
    for (const [other, r] of [...this.records].sort(
      (a, b) => a[1].updated - b[1].updated,
    )) {
      if (size <= resumeTotalLimit) break;
      size -= Buffer.byteLength(r.screen?.data || "");
      r.screen = undefined;
      this.persist(other);
    }
  }
  async hydrate(id: string) {
    const screen = this.get(id)?.screen;
    const epoch = this.epoch;
    if (
      screen &&
      !(await this.request(id, "hydrate", screen)) &&
      this.enabled &&
      epoch === this.epoch
    )
      this.transport.notice(
        id,
        "이전 화면 복원이 지연되어 새 연결을 시작했습니다.",
      );
  }
  close() {
    clearInterval(this.timer);
    for (const [token, request] of [...this.pending]) {
      this.send(request.owner, { kind: "resume-cancel", token });
      request.done();
    }
  }
}
