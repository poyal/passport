import { z } from "zod";

export const shareTextLimit = 256 * 1024;
export const shareFileLimit = 100 * 1024 * 1024;
export const shareOfferLifetime = 10 * 60 * 1000;
export const shareInviteLifetime = 5 * 60 * 1000;
export const shareExtensions = [
  "pdf",
  "txt",
  "md",
  "csv",
  "docx",
  "xlsx",
  "pptx",
  "hwpx",
  "html",
  "htm",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "zip",
  "7z",
] as const;
export const shareLabel = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (v) => !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(v),
    "표시 이름에 제어 문자를 사용할 수 없습니다.",
  );
export const shareSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    discoverable: z.boolean().default(false),
    // Accept old settings without publishing a former self-assigned name.
    // Contact names belong to each user's local address book.
    name: shareLabel
      .default("Passport 사용자")
      .transform(() => "Passport 사용자"),
    address: z.string().max(100).default(""),
    receiveDirectory: z.string().max(4096).default(""),
    retentionDays: z.number().int().min(1).max(30).nullable().default(7),
  })
  .strict();
export type ShareSettings = z.infer<typeof shareSettingsSchema>;
export type ShareEndpoint = { address: string; port: number };
export const shareEndpointSchema = z
  .object({
    address: z.string().min(1).max(100),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
export const shareOfferSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["markdown", "file"]),
    name: shareLabel,
    bytes: z.number().int().min(0).max(shareFileLimit),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (v) => v.kind !== "markdown" || v.bytes <= shareTextLimit,
    "메시지는 256 KiB 이하여야 합니다.",
  );
export type ShareOffer = z.infer<typeof shareOfferSchema>;
export type SharePeer = {
  id: string;
  name: string;
  endpoint: ShareEndpoint;
  blocked: boolean;
};
export type ShareTransferState =
  | "preparing"
  | "pending"
  | "accepted"
  | "sending"
  | "delivered"
  | "rejected"
  | "expired"
  | "cancelled"
  | "failed";
export type ShareTransfer = {
  id: string;
  peerId: string;
  peerName: string;
  direction: "incoming" | "outgoing";
  state: ShareTransferState;
  kind: ShareOffer["kind"];
  name: string;
  bytes: number;
  received: number;
  created: number;
  error?: string;
  destination?: string;
};
export type ShareMessage = {
  id: string;
  peerName: string;
  created: number;
  title: string;
  markdown: string;
};
export type SharePairRequest = {
  id: string;
  name: string;
  fingerprint: string;
  expires: number;
};
export type ShareSnapshot = {
  settings: ShareSettings;
  endpoint?: ShareEndpoint;
  peers: SharePeer[];
  requests: SharePairRequest[];
  transfers: ShareTransfer[];
  messages: Omit<ShareMessage, "markdown">[];
  nearby: { name: string; endpoint: ShareEndpoint }[];
  interfaces: { name: string; address: string }[];
  error?: string;
};
export const shareSendSchema = z
  .object({
    to: z.string().min(1).max(128),
    text: z.string().max(shareTextLimit).optional(),
    file: z.string().min(1).max(4096).optional(),
    markdownFile: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine(
    (v) =>
      [v.text, v.file, v.markdownFile].filter((v) => v !== undefined).length ===
      1,
    "텍스트, Markdown 파일, 첨부 파일 중 하나를 지정하세요.",
  );
export type ShareSend = z.infer<typeof shareSendSchema>;
export const shareControlSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("share.peers") }).strict(),
  z
    .object({ command: z.literal("share.send"), input: shareSendSchema })
    .strict(),
  z
    .object({ command: z.literal("share.status"), id: z.string().uuid() })
    .strict(),
  z
    .object({ command: z.literal("share.cancel"), id: z.string().uuid() })
    .strict(),
]);
export type ShareControlCommand = z.infer<typeof shareControlSchema>;

export function validateMarkdown(text: string) {
  if (new TextEncoder().encode(text).length > shareTextLimit)
    throw new Error("메시지는 UTF-8 256 KiB 이하여야 합니다.");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text))
    throw new Error("메시지에 터미널 제어 문자를 사용할 수 없습니다.");
  return text;
}

export function shareFileName(value: string) {
  const device = value.normalize("NFKC").split(".")[0].trimEnd();
  if (
    !value ||
    value.length > 180 ||
    /[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value) ||
    /^[. ]|[. ]$/.test(value) ||
    /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9]|lpt[0-9])$/i.test(
      device,
    )
  )
    throw new Error("안전하게 저장할 수 없는 파일 이름입니다.");
  const ext = value.split(".").pop()!.toLowerCase();
  if (!(shareExtensions as readonly string[]).includes(ext))
    throw new Error("허용되지 않은 파일 확장자입니다.");
  return value;
}
