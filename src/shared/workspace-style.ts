import { z } from "zod";

export const osIconKinds = [
  "server",
  "alpine",
  "centos",
  "redhat",
  "rocky",
  "ubuntu",
  "debian",
  "fedora",
  "linux",
  "apple",
  "windows",
] as const;
export const workspaceIconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal") }),
  z.object({ kind: z.literal("os"), os: z.enum(osIconKinds) }),
  z.object({
    kind: z.literal("emoji"),
    value: z
      .string()
      .max(64)
      .regex(
        new RegExp("^\\p{RGI_Emoji}$", "v"),
        "이모지를 한 개 입력해 주세요.",
      ),
  }),
]);
export type WorkspaceIcon = z.infer<typeof workspaceIconSchema>;
export const workspaceColorSchema = z
  .string()
  .regex(/^#[a-fA-F0-9]{6}$/, "색상은 #RRGGBB 형식으로 입력해 주세요.")
  .transform((v) => v.toLowerCase());
export const workspaceColors = [
  ["빨강", "#ef4444"],
  ["주황", "#f97316"],
  ["노랑", "#eab308"],
  ["초록", "#22c55e"],
  ["청록", "#14b8a6"],
  ["파랑", "#3b82f6"],
  ["보라", "#a855f7"],
  ["분홍", "#ec4899"],
] as const;
