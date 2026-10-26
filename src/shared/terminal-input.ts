import { z } from "zod";
import { preparePaste } from "./layout";

export const pasteTextLimit = 4 * 1024 * 1024;
export const inputChunkLimit = 32 * 1024;
export const inputPaneLimit = 8 * 1024 * 1024;
export const inputTotalLimit = 32 * 1024 * 1024;
export const inputPaneRequests = 1024;
export const inputTotalRequests = 4096;
export const pasteStart = "\x1b[200~";
export const pasteEnd = "\x1b[201~";
export const pasteSizeMessage =
  "붙여넣을 텍스트는 UTF-8 기준 4 MiB 이하여야 합니다.";
export const inputBusyMessage =
  "터미널 입력 대기 용량을 초과했습니다. 전송이 끝난 뒤 다시 시도하세요.";

export function pasteBytes(text: string) {
  if (text.length > pasteTextLimit) throw new Error(pasteSizeMessage);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > pasteTextLimit) throw new Error(pasteSizeMessage);
  return bytes;
}

export function prepareTerminalPaste(text: string) {
  pasteBytes(text);
  return preparePaste(text).replace(/\r?\n/g, "\r");
}

export const sessionPasteSchema = z.object({
  id: z.string().uuid(),
  sessionInstanceId: z.string().uuid(),
  text: z.string().max(pasteTextLimit, pasteSizeMessage),
  bracketedPaste: z.boolean(),
});
export type SessionPaste = z.infer<typeof sessionPasteSchema>;
export type InputStatus = {
  kind: "terminal-input";
  id: string;
  generation: string;
  requestId: string;
  status: "queued" | "sending" | "completed" | "cancelled" | "failed";
  bytes: number;
  total: number;
  message?: string;
};

// Each process owns its budget. Reservations include in-flight payloads until
// their storage is released, not merely until a write has been scheduled.
export class InputBudget {
  private panes = new Map<string, { bytes: number; requests: number }>();
  bytes = 0;
  requests = 0;
  reserve(id: string, bytes: number) {
    const pane = this.panes.get(id) ?? { bytes: 0, requests: 0 };
    if (
      pane.bytes + bytes > inputPaneLimit ||
      this.bytes + bytes > inputTotalLimit ||
      pane.requests >= inputPaneRequests ||
      this.requests >= inputTotalRequests
    )
      throw new Error(inputBusyMessage);
    pane.bytes += bytes;
    pane.requests++;
    this.panes.set(id, pane);
    this.bytes += bytes;
    this.requests++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pane.bytes -= bytes;
      pane.requests--;
      this.bytes -= bytes;
      this.requests--;
      if (!pane.requests) this.panes.delete(id);
    };
  }
}
