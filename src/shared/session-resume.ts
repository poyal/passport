import { z } from "zod";
import { unicodeWidthSchema } from "./terminal-config";

export const resumeReconnectMessage =
  "이 연결은 복원을 켜기 전에 시작되어 화면만 저장됩니다. 작업을 마친 뒤 다시 연결하세요. 로컬 AI 대화는 적용 후 실행한 것부터 추적합니다.";
export const resumeUntrackedMessage =
  "이전 연결에 복원 연동이 적용되지 않아 화면만 복원했습니다. 새 연결부터 작업 폴더와 로컬 AI 복원을 적용합니다.";

export const resumeScreenLimit = 2 * 1024 * 1024;
export const resumeTotalLimit = 64 * 1024 * 1024;
export const resumeScreenSchema = z.object({
  id: z.string().min(1).max(160),
  data: z.string().max(resumeScreenLimit),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500),
  unicodeWidth: unicodeWidthSchema.optional(),
});
export type ResumeScreen = z.infer<typeof resumeScreenSchema>;
export const nativeSessionId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export const agentResumeSchema = z.object({
  agent: z.enum(["codex", "claude"]),
  args: z.array(z.string().max(8192)).max(128),
  cwd: z.string().min(1).max(4096),
  session: z.string().regex(nativeSessionId).optional(),
  // A native session ID can exist before the CLI has saved any conversation.
  hasConversation: z.boolean().optional(),
  transcript: z.string().max(4096).optional(),
  home: z.string().max(4096).optional(),
  running: z.boolean(),
  reason: z.string().max(512).optional(),
});
export type AgentResume = z.infer<typeof agentResumeSchema>;
export type ResumeSummary = { id: string; automatic: boolean };
export type ResumeEvent =
  | { kind: "resume-cancel"; token: string }
  | { kind: "resume-checkpoint"; id: string; token: string }
  | { kind: "resume-hydrate"; id: string; token: string; screen: ResumeScreen };
