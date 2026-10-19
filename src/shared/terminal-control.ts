import { z } from "zod";
import { shareControlSchema } from "./share";

export const controlModeSchema = z.enum(["off", "read", "write"]);
export type ControlMode = z.infer<typeof controlModeSchema>;
export const controlKeys = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  backspace: "\x7f",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
} as const;
export const controlTextLimit = 256 * 1024;
export const controlReadLimit = 1024 * 1024;
export const controlTimeout = 5000;
const target = {
  pane: z.string().uuid().optional(),
  tab: z.string().min(1).max(100).optional(),
};
export const controlCommandSchema = z.discriminatedUnion("command", [
  ...shareControlSchema.options,
  z.object({ command: z.literal("list") }).strict(),
  z.object({ command: z.literal("identify") }).strict(),
  z
    .object({
      command: z.literal("read"),
      ...target,
      lines: z.number().int().min(1).max(1000).default(100),
    })
    .strict(),
  z
    .object({
      command: z.literal("send"),
      ...target,
      text: z.string().max(controlTextLimit),
      submit: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      command: z.literal("key"),
      ...target,
      key: z.enum(["enter", "esc", "tab", "backspace", "ctrl-c", "ctrl-d"]),
    })
    .strict(),
]);
export type ControlCommand = z.infer<typeof controlCommandSchema>;
export const controlRequestSchema = z
  .object({
    version: z.literal(1),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    source: z
      .object({ paneId: z.string().uuid(), sessionId: z.string().uuid() })
      .strict(),
    request: controlCommandSchema,
  })
  .strict();
export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type ControlPanel = {
  paneId: string;
  workspaceId: string;
  workspaceName: string;
  windowId: number;
  sessionId: string | null;
  status: "connected" | "disconnected";
  shell: string;
  launchCwd: string;
  configuredAgent: string | null;
  moving: boolean;
};
export type ControlInspectionRequest = {
  requestId: string;
  paneId: string;
  sessionId: string | null;
  lines?: number;
};
export const controlInspectionSchema = z
  .object({
    requestId: z.string().uuid(),
    paneId: z.string().uuid(),
    sessionId: z.string().uuid().nullable(),
    error: z.enum(["NOT_READY", "SESSION_CHANGED", "MOVING"]).optional(),
    bracketedPaste: z.boolean().optional(),
    backspace: z.enum(["BS", "DEL"]).optional(),
    text: z.string().max(controlReadLimit).optional(),
    buffer: z.enum(["normal", "alternate"]).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ControlInspection = z.infer<typeof controlInspectionSchema>;
export type ControlResponse =
  | { version: 1; ok: true; value: unknown }
  | {
      version: 1;
      ok: false;
      error: { code: string; message: string; osCode?: number };
    };
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// CLI text is literal. Unlike the UI paste helper, trailing newlines are data.
export function controlPaste(
  text: string,
  bracketed: boolean,
  submit: boolean,
): string {
  if (new TextEncoder().encode(text).length > controlTextLimit)
    throw new ControlError(
      "TOO_LARGE",
      "입력은 UTF-8 256 KiB 이하여야 합니다.",
    );
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text))
    throw new ControlError(
      "CONTROL_CHARACTER",
      "텍스트에 제어 문자를 사용할 수 없습니다. passport key를 사용하세요.",
    );
  if (/[\t\r\n]/.test(text) && !bracketed)
    throw new ControlError(
      "PASTE_UNSUPPORTED",
      "대상이 여러 줄·탭 붙여넣기를 지원하지 않습니다.",
    );
  const data = text.replace(/\r\n|\r|\n/g, "\r");
  return (
    (bracketed && data ? `\x1b[200~${data}\x1b[201~` : data) +
    (submit ? "\r" : "")
  );
}

// The small interface allows testing real terminal semantics without Electron.
export interface ReadableTerminalBuffer {
  length: number;
  getLine(
    index: number,
  ):
    | { isWrapped: boolean; translateToString(trimRight?: boolean): string }
    | undefined;
}
export function readControlText(buffer: ReadableTerminalBuffer, lines: number) {
  const result: string[] = [];
  let current = "",
    started = false,
    remaining = controlReadLimit,
    truncated = false;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const row = buffer.getLine(i);
    if (!row) continue;
    // Preserve spaces at soft wraps, trim padding only at a logical line end.
    const text = row
      .translateToString(!current)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
    if (!started && !text && !row.isWrapped) continue;
    started = true;
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > remaining) {
      truncated = true;
      break;
    }
    remaining -= bytes;
    current = text + current;
    if (!row.isWrapped || i === 0) {
      result.push(current);
      current = "";
      remaining--;
      if (result.length === lines || remaining <= 0) {
        truncated = i > 0;
        break;
      }
    }
  }
  if (current) result.push(current);
  return { text: result.reverse().join("\n"), truncated };
}
