import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import {
  InputBudget,
  inputChunkLimit,
  pasteStart,
  pasteEnd,
  prepareTerminalPaste,
  type InputStatus,
} from "../shared/terminal-input";

const budget = new InputBudget();
type Operation = {
  data: Buffer;
  release(): void;
  paste?: { requestId: string; generation: string };
  cancelled: boolean;
  offset: number;
  finished: boolean;
  binary: boolean;
  closingOffset?: number;
};
type Writer = (data: Buffer, done: (error?: Error | null) => void) => void;

export function ptyInputWriter(pty: IPty): Writer {
  const patched = pty as IPty & { passportWrite?: Writer };
  if (!patched.passportWrite)
    throw new Error("PTY 입력 패치가 없습니다. 의존성을 다시 준비하세요.");
  return (data, done) => patched.passportWrite!(data, done);
}

// One logical input at a time, with at most one native write in flight.
export class TerminalInputQueue {
  private pending: Operation[] = [];
  private current?: Operation;
  private disposed = false;
  private abortWrite?: () => void;
  constructor(
    private readonly id: string,
    private readonly write: Writer,
    private readonly emit: (event: InputStatus) => void,
    private readonly failed: (error: Error) => void,
    private readonly transform: (data: string) => string = (data) => data,
    private readonly limits = budget,
  ) {}
  get busy() {
    return !!this.current || this.pending.length > 0;
  }

  input(data: string, binary = false) {
    if (data === "\x03" && this.busy) this.cancel();
    this.enqueue(
      Buffer.from(data, binary ? "latin1" : "utf8"),
      undefined,
      undefined,
      binary,
    );
  }

  paste(text: string, bracketed: boolean, generation: string) {
    const prepared = prepareTerminalPaste(text);
    const requestId = randomUUID();
    const data = bracketed ? pasteStart + prepared + pasteEnd : prepared;
    this.enqueue(
      Buffer.from(data),
      { requestId, generation },
      Buffer.byteLength(prepared),
    );
    return requestId;
  }

  private enqueue(
    data: Buffer,
    paste?: Operation["paste"],
    bytes = data.length,
    binary = false,
  ) {
    if (this.disposed) throw new Error("터미널 입력 연결이 종료되었습니다.");
    const operation: Operation = {
      data,
      paste,
      release: this.limits.reserve(this.id, bytes),
      cancelled: false,
      offset: 0,
      finished: false,
      binary,
      closingOffset:
        !binary &&
        data.subarray(0, pasteStart.length).toString() === pasteStart &&
        (data.subarray(-pasteEnd.length).toString() === pasteEnd ||
          data.subarray(-pasteEnd.length - 1).toString() === pasteEnd + "\r")
          ? data.lastIndexOf(pasteEnd)
          : undefined,
    };
    this.pending.push(operation);
    this.report(operation, "queued");
    // Keep admission synchronous; process accepted operations outside enqueue.
    queueMicrotask(() => void this.drain());
  }

  private report(
    op: Operation,
    status: InputStatus["status"],
    message?: string,
  ) {
    if (op.paste)
      this.emit({
        kind: "terminal-input",
        id: this.id,
        generation: op.paste.generation,
        requestId: op.paste.requestId,
        status,
        bytes: op.offset,
        total: op.data.length,
        message,
      });
  }

  private finish(
    op: Operation,
    status: InputStatus["status"],
    message?: string,
  ) {
    if (op.finished) return;
    op.finished = true;
    this.report(op, status, message);
    op.data = Buffer.alloc(0);
    op.release();
  }

  cancel() {
    if (this.current) this.current.cancelled = true;
    for (const op of this.pending.splice(0)) this.finish(op, "cancelled");
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    if (this.current) this.finish(this.current, "cancelled");
    this.abortWrite?.();
  }

  private writeChunk(data: Buffer) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        this.abortWrite = undefined;
        error ? reject(error) : resolve();
      };
      this.abortWrite = () =>
        done(new Error("터미널 입력 연결이 종료되었습니다."));
      try {
        this.write(data, done);
      } catch (error) {
        done(error as Error);
      }
    });
  }

  private async drain() {
    if (this.current || this.disposed) return;
    const op = this.pending.shift();
    if (!op) return;
    this.current = op;
    try {
      if (!op.binary)
        op.data = Buffer.from(this.transform(op.data.toString("utf8")));
      if (op.closingOffset !== undefined)
        op.closingOffset = op.data.lastIndexOf(pasteEnd);
      this.report(op, "sending");
      while (op.offset < op.data.length && !op.cancelled && !this.disposed) {
        let end = Math.min(op.offset + inputChunkLimit, op.data.length);
        if (
          op.closingOffset !== undefined &&
          end < op.closingOffset + pasteEnd.length &&
          end > op.closingOffset
        )
          end = op.closingOffset;
        // UTF-8 text remains complete at each transport boundary. Binary input
        // can use the same boundary rule without changing its concatenated bytes.
        while (
          end < op.data.length &&
          end > op.offset &&
          (op.data[end] & 0xc0) === 0x80
        )
          end--;
        if (end === op.offset)
          end = Math.min(op.offset + inputChunkLimit, op.data.length);
        await this.writeChunk(op.data.subarray(op.offset, end));
        op.offset = end;
        if (!this.disposed) this.report(op, "sending");
        if (op.offset < op.data.length && !this.disposed)
          await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (
        op.cancelled &&
        !this.disposed &&
        op.closingOffset !== undefined &&
        op.offset > 0 &&
        op.offset < op.closingOffset + pasteEnd.length
      )
        await this.writeChunk(Buffer.from(pasteEnd));
      this.finish(
        op,
        op.cancelled || this.disposed ? "cancelled" : "completed",
      );
    } catch (error) {
      if (!this.disposed) {
        const failure =
          error instanceof Error
            ? error
            : new Error("터미널 입력 전송에 실패했습니다.");
        this.finish(op, "failed", failure.message);
        // A failed native write can be partial. Never continue the old input or
        // a bracketed paste on a replacement connection.
        this.dispose();
        this.failed(failure);
      }
    } finally {
      this.current = undefined;
      if (!this.disposed) queueMicrotask(() => void this.drain());
    }
  }
}
