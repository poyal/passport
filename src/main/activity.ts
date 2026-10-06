import net from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { Activity } from "../shared/model";
import { platform } from "./platform";
import type { ActivityEndpoint } from "./platform/contracts";

const wire = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().uuid(),
  source: z.enum(["claude", "codex", "terminal"]),
  event: z.enum([
    "ready",
    "profile-result",
    "run-start",
    "run-end",
    "session-end",
    "turn-failed",
    "turn-start",
    "tool-done",
    "completed",
    "stop-candidate",
    "permission-candidate",
    "permission",
    "attention",
  ]),
  run: z.string().max(160).default(""),
  agentRun: z.string().max(160).optional(),
  session: z.string().max(160).optional(),
  turn: z.string().max(160).optional(),
  request: z.string().max(160).optional(),
  detail: z.string().max(4096).optional(),
});
type Wire = z.infer<typeof wire>;
type Live = {
  paneId: string;
  generation: string;
  token: string;
  runs: Set<string>;
  recent: Map<string, number>;
  count: number;
  since: number;
  parser: OscNotifications;
  enabled: { claude: boolean; codex: boolean };
};

// Stream parser runs once on original PTY output in main. Snapshot replay never
// enters it, and control strings split across output chunks remain intact.
export class OscNotifications {
  private state = 0;
  private value = "";
  constructor(private receive: (value: string) => void) {}
  push(data: string) {
    for (const char of data) {
      if (this.state === 0) {
        if (char === "\x1b") this.state = 1;
      } else if (this.state === 1) {
        this.state = char === "]" ? 2 : char === "\x1b" ? 1 : 0;
        this.value = "";
      } else if (this.state === 2) {
        if (char === "\x07") this.finish();
        else if (char === "\x1b") this.state = 3;
        else if (this.value.length < 4096) this.value += char;
        else {
          this.value = "";
          this.state = 4;
        }
      } else if (this.state === 3) {
        if (char === "\\") this.finish();
        else {
          this.value = "";
          this.state = 0;
        }
      } else if (this.state === 4) {
        if (char === "\x07") this.state = 0;
        else if (char === "\x1b") this.state = 5;
      } else this.state = char === "\\" ? 0 : 4;
    }
  }
  private finish() {
    const value = this.value;
    this.value = "";
    this.state = 0;
    if (value.startsWith("9;") || value.startsWith("777;notify;"))
      this.receive(value);
  }
}
export class ActivityService {
  readonly live = new Map<string, Live>();
  private rows: (Activity & { run?: string; request?: string })[] = [];
  private server = net.createServer((socket) => {
    if (this.sockets.size >= 32) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let raw = Buffer.alloc(0);
    socket.setTimeout(500, () => socket.destroy());
    socket.on("data", (chunk) => {
      if (raw.length + chunk.length > 16384) {
        socket.destroy();
        return;
      }
      raw = Buffer.concat([
        raw,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      const end = raw.indexOf(10);
      if (end < 0) return;
      try {
        this.receive(JSON.parse(raw.subarray(0, end).toString("utf8")));
      } catch {
        /* untrusted local input */
      }
      socket.end("ok\n");
    });
    socket.on("error", () => {});
    socket.on("close", () => this.sockets.delete(socket));
  });
  private sockets = new Set<net.Socket>();
  private endpointResource?: ActivityEndpoint;
  endpoint = "";
  constructor(
    private db: Database.Database,
    private callbacks: {
      workspace: (paneId: string) => string | undefined;
      changed: (items: Activity[]) => void;
      notify: (item: Activity) => void;
      viewed?: (paneId: string) => boolean;
      ready: (paneId: string, generation: string, result?: string) => void;
      error: (message: string) => void;
    },
  ) {
    const records = db
      .prepare("SELECT value FROM activity ORDER BY created DESC LIMIT 500")
      .all() as { value: string }[];
    for (const row of records) {
      try {
        this.rows.push({ ...JSON.parse(row.value), resolved: true });
      } catch {
        /* damaged row */
      }
    }
    this.persist();
  }
  async start() {
    this.endpointResource = platform.createActivityEndpoint();
    this.endpoint = this.endpointResource.address;
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.endpoint, () => {
          this.server.removeListener("error", reject);
          resolve();
        });
      });
      this.endpointResource.listening();
    } catch (error) {
      await this.close();
      throw error;
    }
    this.server.on("error", () =>
      this.callbacks.error(
        "알림 수신 연결이 끊겼습니다. 앱을 다시 시작하세요.",
      ),
    );
  }
  register(
    paneId: string,
    generation: string,
    enabled = { claude: false, codex: false },
  ) {
    this.unregister(paneId);
    const token = randomBytes(32).toString("hex");
    const entry: Live = {
      paneId,
      generation,
      token,
      runs: new Set(),
      recent: new Map(),
      count: 0,
      since: Date.now(),
      enabled,
      parser: new OscNotifications(() => this.attention(paneId)),
    };
    this.live.set(paneId, entry);
    return {
      PASSPORT_ENDPOINT: this.endpoint,
      PASSPORT_TOKEN: token,
      PASSPORT_GENERATION: generation,
    };
  }
  unregister(paneId: string) {
    const old = this.live.get(paneId);
    this.live.delete(paneId);
    if (old) {
      for (const row of this.rows)
        if (row.generation === old.generation) row.resolved = true;
      this.persist();
    }
  }
  restrictAgents(allowed: { claude: boolean; codex: boolean }) {
    let changed = false;
    for (const entry of this.live.values())
      for (const source of ["claude", "codex"] as const)
        if (!allowed[source] && entry.enabled[source]) {
          // Revocation applies immediately. Enabling again requires a fresh
          // session, so credentials from the revoked launch cannot revive.
          entry.enabled[source] = false;
          changed = true;
          for (const row of this.rows)
            if (row.generation === entry.generation && row.source === source)
              row.resolved = true;
        }
    if (changed) this.persist();
  }
  observe(paneId: string, data: string) {
    this.live.get(paneId)?.parser.push(data);
  }
  private allow(entry: Live, key: string) {
    const now = Date.now();
    if (now - entry.since > 1000) {
      entry.since = now;
      entry.count = 0;
    }
    if (++entry.count > 20) return false;
    if (now - (entry.recent.get(key) || 0) < 5000) return false;
    entry.recent.set(key, now);
    if (entry.recent.size > 128)
      entry.recent.delete(entry.recent.keys().next().value!);
    return true;
  }
  receive(raw: unknown) {
    const parsed = wire.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    const entry = [...this.live.values()].find(
      (s) => s.generation === event.generation,
    );
    if (
      !entry ||
      !timingSafeEqual(Buffer.from(entry.token), Buffer.from(event.token))
    )
      return;
    if (event.event === "ready" || event.event === "profile-result") {
      this.callbacks.ready(
        entry.paneId,
        entry.generation,
        event.event === "profile-result" ? event.detail : undefined,
      );
      return;
    }
    if (event.source === "terminal" || !entry.enabled[event.source]) return;
    const run = event.agentRun || event.run;
    if (event.event === "run-start") {
      if (run && entry.runs.size < 64) entry.runs.add(run);
      return;
    }
    if (!run || !entry.runs.has(run)) return;
    if (
      [
        "tool-done",
        "turn-start",
        "run-end",
        "session-end",
        "turn-failed",
      ].includes(event.event)
    ) {
      for (const row of this.rows)
        if (
          row.generation === entry.generation &&
          row.run === run &&
          (event.event !== "tool-done" ||
            (!!event.request && row.request === event.request))
        )
          row.resolved = true;
      if (event.event === "run-end") entry.runs.delete(run);
      this.persist();
      return;
    }
    const key = `${event.source}:${run}:${event.event}:${event.turn || ""}:${event.request || ""}`;
    if (!this.allow(entry, key)) return;
    if (event.event === "stop-candidate")
      for (const row of this.rows) {
        // Reaching the root Stop hook confirms progress past previous waits. It
        // does not confirm that other Stop hooks will let the agent finish.
        if (row.generation === entry.generation && row.run === run)
          row.resolved = true;
      }
    const kind: Activity["kind"] =
      event.event === "completed"
        ? "completed"
        : event.event === "permission"
          ? "permission"
          : "attention";
    const label =
      event.event === "stop-candidate"
        ? "응답 종료 신호"
        : kind === "completed"
          ? "응답 완료"
          : kind === "permission"
            ? "승인 필요"
            : "확인 필요";
    this.add(entry, {
      source: event.source,
      kind,
      title: `${event.source === "claude" ? "Claude Code" : "Codex"} · ${label}`,
      body:
        event.event === "stop-candidate"
          ? "Stop 신호가 도착했습니다. 다른 훅이나 백그라운드 작업은 계속될 수 있습니다."
          : "터미널에서 내용을 확인하세요.",
      run,
      request: event.request,
    });
  }
  private attention(paneId: string) {
    const entry = this.live.get(paneId);
    if (entry && this.allow(entry, "osc"))
      this.add(entry, {
        source: "terminal",
        kind: "attention",
        title: "터미널 · 확인 필요",
        body: "터미널이 알림 신호를 보냈습니다. 내용과 요청자는 해당 화면에서 확인하세요.",
      });
  }
  private add(
    entry: Live,
    event: Pick<Activity, "source" | "kind" | "title" | "body"> & {
      run?: string;
      request?: string;
    },
  ) {
    const workspaceId = this.callbacks.workspace(entry.paneId);
    if (!workspaceId) return;
    const item = {
      ...event,
      id: randomUUID(),
      paneId: entry.paneId,
      generation: entry.generation,
      workspaceId,
      created: Date.now(),
      read: this.callbacks.viewed?.(entry.paneId) ?? false,
      resolved: event.kind !== "permission",
    };
    this.rows.unshift(item);
    this.persist();
    if (!item.read) this.callbacks.notify(item);
  }
  list() {
    this.prune();
    return this.rows.map((row) => ({
      ...row,
      available: this.live.get(row.paneId)?.generation === row.generation,
    }));
  }
  read(id?: string) {
    this.markRead((row) => !id || row.id === id);
  }
  readPane(paneId: string) {
    this.markRead((row) => row.paneId === paneId);
  }
  private markRead(matches: (row: Activity) => boolean) {
    let changed = false;
    for (const row of this.rows)
      if (!row.read && matches(row)) {
        row.read = true;
        changed = true;
      }
    if (changed) this.persist();
  }
  clear() {
    this.rows = [];
    this.persist();
  }
  active(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row || this.live.get(row.paneId)?.generation !== row.generation)
      throw new Error("종료된 터미널의 알림입니다.");
    return row;
  }
  private prune() {
    this.rows = this.rows
      .filter((r) => Date.now() - r.created < 7 * 86400000)
      .slice(0, 500);
  }
  private persist() {
    this.prune();
    try {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM activity").run();
        const insert = this.db.prepare(
          "INSERT INTO activity(id,created,value) VALUES(?,?,?)",
        );
        for (const row of this.rows)
          insert.run(row.id, row.created, JSON.stringify(row));
      })();
    } catch {
      this.callbacks.error(
        "알림 기록을 저장하지 못했습니다. 현재 실행 중에는 메모리에 유지합니다.",
      );
    }
    this.callbacks.changed(this.list());
  }
  async close() {
    this.live.clear();
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.endpointResource?.dispose();
    this.endpointResource = undefined;
  }
}
