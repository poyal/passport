import net from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ControlError,
  controlRequestSchema,
  controlKeys,
  controlPaste,
  controlTimeout,
  type ControlMode,
  type ControlPanel,
  type ControlRequest,
  type ControlResponse,
  type ControlInspection,
  type ControlInspectionRequest,
} from "../shared/terminal-control";
import type { ActivityEndpoint } from "./platform/contracts";
import type { ShareControlCommand } from "../shared/share";

type Credential = { token: string; sessionId: string; abort: AbortController };
export class TerminalControl {
  private mode: ControlMode = "off";
  private sharing = false;
  private credentials = new Map<string, Credential>();
  private sockets = new Set<net.Socket>();
  private queues = new Map<string, Promise<unknown>>();
  private server?: net.Server;
  constructor(
    private readonly options: {
      endpoint: ActivityEndpoint;
      panels(): ControlPanel[];
      tabMatches?(name: string): number;
      inspect(
        panel: ControlPanel,
        lines: number | undefined,
        signal: AbortSignal,
      ): Promise<ControlInspection>;
      write(paneId: string, data: string): void;
      share?: {
        enabled(): boolean;
        execute(input: ShareControlCommand, authorize: () => void): unknown;
      };
    },
  ) {}
  async start() {
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.endpoint.address, () => {
        this.server!.removeListener("error", reject);
        try {
          this.options.endpoint.listening();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    this.server.on("error", () => {
      this.configure("off");
    });
  }
  configure(mode: ControlMode) {
    const sharing = this.options.share?.enabled() ?? false;
    if (this.mode === mode && this.sharing === sharing) return;
    for (const id of this.credentials.keys()) this.unregister(id);
    this.mode = mode;
    this.sharing = sharing;
  }
  register(paneId: string, sessionId: string): Record<string, string> {
    this.unregister(paneId);
    const context = {
      PASSPORT_PANE_ID: paneId,
      PASSPORT_SESSION_ID: sessionId,
    };
    if (this.mode === "off" && !this.sharing) return context;
    const credential = {
      token: randomBytes(32).toString("hex"),
      sessionId,
      abort: new AbortController(),
    };
    this.credentials.set(paneId, credential);
    return {
      ...context,
      PASSPORT_CONTROL_ENDPOINT: this.options.endpoint.address,
      PASSPORT_CONTROL_TOKEN: credential.token,
    };
  }
  unregister(paneId: string) {
    this.credentials.get(paneId)?.abort.abort();
    this.credentials.delete(paneId);
  }
  async close() {
    for (const id of this.credentials.keys()) this.unregister(id);
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.options.endpoint.dispose();
  }
  private accept(socket: net.Socket) {
    if (this.sockets.size >= 32) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const abort = new AbortController();
    let chunks: Buffer[] = [],
      bytes = 0,
      received = false;
    const timer = setTimeout(() => {
      abort.abort();
      socket.destroy();
    }, controlTimeout);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      abort.abort();
      this.sockets.delete(socket);
    });
    socket.on("data", (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (received) return;
      bytes += data.length;
      if (bytes > 2 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      chunks.push(data);
      if (!data.includes(10)) return;
      received = true;
      const buffer = Buffer.concat(chunks);
      chunks = [];
      void (async () => {
        let response: ControlResponse;
        try {
          const raw = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              buffer.subarray(0, buffer.indexOf(10)),
            ),
          );
          const parsed = controlRequestSchema.safeParse(raw);
          if (!parsed.success)
            throw new ControlError(
              "INVALID_REQUEST",
              "CLI 요청 형식이 올바르지 않습니다.",
            );
          response = {
            version: 1,
            ok: true,
            value: await this.execute(parsed.data, abort.signal),
          };
        } catch (error) {
          response = {
            version: 1,
            ok: false,
            error:
              error instanceof ControlError
                ? { code: error.code, message: error.message }
                : {
                    code: "INTERNAL_ERROR",
                    message: "CLI 요청을 처리하지 못했습니다.",
                  },
          };
        }
        if (!abort.signal.aborted) socket.end(JSON.stringify(response) + "\n");
      })();
    });
  }
  async execute(
    input: ControlRequest,
    clientSignal = new AbortController().signal,
  ): Promise<unknown> {
    const credential = this.credentials.get(input.source.paneId);
    if (
      (this.mode === "off" && !this.sharing) ||
      !credential ||
      credential.sessionId !== input.source.sessionId ||
      input.token.length !== credential.token.length ||
      !timingSafeEqual(Buffer.from(input.token), Buffer.from(credential.token))
    )
      throw new ControlError(
        "UNAUTHORIZED",
        "CLI 접근 권한이 없습니다. 설정을 확인하고 새 로컬 터미널을 여세요.",
      );
    const signal = AbortSignal.any([
      clientSignal,
      credential.abort.signal,
      AbortSignal.timeout(controlTimeout),
    ]);
    const authorize = () => {
      if (
        signal.aborted ||
        this.credentials.get(input.source.paneId) !== credential
      )
        throw new ControlError(
          "CANCELLED",
          "요청이 만료되었거나 CLI 접근 권한이 변경되었습니다.",
        );
      const source = this.options
        .panels()
        .find((p) => p.paneId === input.source.paneId);
      if (
        !source ||
        source.sessionId !== credential.sessionId ||
        source.status !== "connected"
      )
        throw new ControlError(
          "UNAUTHORIZED",
          "명령을 실행한 로컬 터미널 세션이 종료되었습니다.",
        );
      return source;
    };
    const source = authorize(),
      request = input.request;
    if (
      request.command === "share.peers" ||
      request.command === "share.inbox" ||
      request.command === "share.approve" ||
      request.command === "share.read" ||
      request.command === "share.send" ||
      request.command === "share.status" ||
      request.command === "share.cancel"
    ) {
      if (!this.sharing || !this.options.share?.enabled())
        throw new ControlError("UNAUTHORIZED", "쪽지 기능이 꺼져 있습니다.");
      authorize();
      return this.options.share.execute(request, () => {
        authorize();
        if (!this.sharing || !this.options.share?.enabled())
          throw new ControlError("UNAUTHORIZED", "쪽지 기능이 꺼져 있습니다.");
      });
    }
    if (this.mode === "off")
      throw new ControlError("UNAUTHORIZED", "터미널 제어 권한이 없습니다.");
    if (request.command === "list") return this.options.panels();
    if (request.command === "identify") return source;
    if (!!request.pane === !!request.tab)
      throw new ControlError(
        "INVALID_TARGET",
        "--pane ID 또는 --tab 이름 중 하나를 지정하세요.",
      );
    const candidates = this.options
      .panels()
      .filter((p) =>
        request.pane
          ? p.paneId === request.pane
          : p.workspaceName === request.tab,
      );
    if (
      request.tab &&
      this.options.tabMatches &&
      this.options.tabMatches(request.tab) > 1
    )
      throw new ControlError(
        "AMBIGUOUS_TARGET",
        `이름이 같은 탭이 여러 개입니다. passport list에서 --pane ID를 선택하세요: ${candidates.map((p) => p.paneId).join(", ")}`,
      );
    if (!candidates.length)
      throw new ControlError("NOT_FOUND", "대상 로컬 패널을 찾을 수 없습니다.");
    if (candidates.length !== 1)
      throw new ControlError(
        "AMBIGUOUS_TARGET",
        `대상이 여러 개입니다. --pane ID를 사용하세요: ${candidates.map((p) => p.paneId).join(", ")}`,
      );
    const target = { ...candidates[0] };
    const validate = () => {
      authorize();
      const current = this.options
        .panels()
        .find((p) => p.paneId === target.paneId);
      if (
        !current ||
        current.sessionId !== target.sessionId ||
        current.windowId !== target.windowId
      )
        throw new ControlError(
          "SESSION_CHANGED",
          "대상 패널의 세션 또는 소유 창이 변경되었습니다.",
        );
      if (current.moving)
        throw new ControlError(
          "MOVING",
          "대상 탭을 다른 창으로 이동하고 있습니다.",
        );
      if (
        request.command !== "read" &&
        (this.mode !== "write" || current.status !== "connected")
      )
        throw new ControlError(
          this.mode !== "write" ? "READ_ONLY" : "DISCONNECTED",
          "입력 권한 또는 연결된 대상 터미널이 필요합니다.",
        );
    };
    const operation = async () => {
      validate();
      const inspected = await this.options.inspect(
        target,
        request.command === "read" ? request.lines : undefined,
        signal,
      );
      validate();
      if (inspected.error)
        throw new ControlError(
          inspected.error,
          "대상 화면을 사용할 수 없습니다. 이동·초기화 완료 후 다시 시도하세요.",
        );
      if (inspected.sessionId !== target.sessionId)
        throw new ControlError(
          "SESSION_CHANGED",
          "대상 화면의 세션이 변경되었습니다.",
        );
      if (request.command === "read") {
        if (inspected.text === undefined || !inspected.buffer)
          throw new ControlError(
            "NOT_READY",
            "대상 화면이 준비되지 않았습니다.",
          );
        return {
          paneId: target.paneId,
          sessionId: target.sessionId,
          text: inspected.text,
          buffer: inspected.buffer,
          truncated: !!inspected.truncated,
        };
      }
      const data =
        request.command === "send"
          ? controlPaste(
              request.text,
              !!inspected.bracketedPaste,
              request.submit,
            )
          : request.key === "backspace" && inspected.backspace === "BS"
            ? "\b"
            : controlKeys[request.key];
      // Text and optional Enter are one write. No UI focus or broadcast path.
      this.options.write(target.paneId, data);
      return {
        paneId: target.paneId,
        sessionId: target.sessionId,
        accepted: true,
      };
    };
    const previous = this.queues.get(target.paneId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.queues.set(target.paneId, task);
    try {
      return await task;
    } finally {
      if (this.queues.get(target.paneId) === task)
        this.queues.delete(target.paneId);
    }
  }
}

// Renderer replies are accepted only from the owner captured for this request.
export class ControlInspector {
  private pending = new Map<
    string,
    {
      owner: number;
      request: ControlInspectionRequest;
      resolve(value: ControlInspection): void;
      reject(error: Error): void;
    }
  >();
  constructor(
    private readonly send: (
      owner: number,
      request: ControlInspectionRequest,
    ) => void,
  ) {}
  inspect = (
    panel: ControlPanel,
    lines: number | undefined,
    signal: AbortSignal,
  ): Promise<ControlInspection> => {
    const request: ControlInspectionRequest = {
      requestId: randomUUID(),
      paneId: panel.paneId,
      sessionId: panel.sessionId,
      lines,
    };
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.pending.delete(request.requestId);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        finish();
        reject(
          new ControlError("CANCELLED", "화면 확인 요청이 취소되었습니다."),
        );
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(request.requestId, {
        owner: panel.windowId,
        request,
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      try {
        this.send(panel.windowId, request);
      } catch {
        finish();
        reject(new ControlError("NOT_READY", "대상 창을 사용할 수 없습니다."));
      }
    });
  };
  reply(owner: number, value: ControlInspection) {
    const pending = this.pending.get(value.requestId);
    if (
      !pending ||
      pending.owner !== owner ||
      pending.request.paneId !== value.paneId ||
      pending.request.sessionId !== value.sessionId
    )
      return;
    pending.resolve(value);
  }
}
