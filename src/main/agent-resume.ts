import type { AgentResume } from "../shared/session-resume";
import fs from "node:fs/promises";

// Argument arities are explicit: a new/unknown CLI flag must never turn its
// value into a prompt, or silently change the permissions of a resumed agent.
const codexValues = new Set([
  "-a",
  "--ask-for-approval",
  "-s",
  "--sandbox",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--local-provider",
  "--add-dir",
]);
const codexFlags = new Set([
  "--oss",
  "--search",
  "--no-alt-screen",
  "--no-daemon",
  "--strict-config",
  "--approve-for-me",
  "--full-auto",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
]);
const claudeValues = new Set([
  "--model",
  "--fallback-model",
  "--permission-mode",
  "--settings",
  "--setting-sources",
  "--add-dir",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--tools",
  "--mcp-config",
  "--agent",
  "--agents",
  "--system-prompt",
  "--system-prompt-file",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--effort",
  "--betas",
  "--plugin-dir",
]);
const claudeFlags = new Set([
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--ide",
  "--chrome",
  "--no-chrome",
  "--verbose",
]);
export function resumeArguments(
  agent: AgentResume["agent"],
  input: string[],
): { args: string[]; reason?: string } {
  const args: string[] = [];
  const values = agent === "codex" ? codexValues : claudeValues;
  const flags = agent === "codex" ? codexFlags : claudeFlags;
  let command = false;
  for (let i = 0; i < input.length; i++) {
    const raw = input[i],
      equal = raw.indexOf("="),
      key = equal > 0 ? raw.slice(0, equal) : raw;
    if (raw === "--") break; // remaining positional arguments are initial input
    if (agent === "codex" && !raw.startsWith("-")) {
      if (!command && raw === "resume") {
        command = true;
        continue;
      }
      if (
        !command &&
        [
          "exec",
          "e",
          "review",
          "fork",
          "login",
          "logout",
          "mcp",
          "mcp-server",
          "app-server",
          "app",
          "completion",
          "sandbox",
          "debug",
          "apply",
          "cloud",
          "features",
          "remote-control",
          "agents",
          "queue",
          "archive",
          "delete",
          "unarchive",
        ].includes(raw)
      )
        return { args: [], reason: "대화형 로컬 AI 실행만 자동 복원합니다." };
      continue; // session selector or initial prompt
    }
    if (!raw.startsWith("-")) continue;
    if (
      agent === "codex" &&
      ["--last", "--all", "--include-non-interactive"].includes(key)
    )
      continue;
    if (agent === "claude" && ["-c", "--continue"].includes(key)) continue;
    if (
      agent === "claude" &&
      ["-r", "--resume", "--session-id"].includes(key)
    ) {
      if (equal < 0 && input[i + 1] && !input[i + 1].startsWith("-")) i++;
      continue;
    }
    if (agent === "codex" && ["-i", "--image", "-C", "--cd"].includes(key)) {
      if (equal < 0) {
        if (!input[++i])
          return { args: [], reason: "실행 옵션의 값이 없습니다." };
      }
      continue; // use the actual reported agent cwd, never attach input twice
    }
    if (values.has(key)) {
      args.push(raw);
      if (equal < 0) {
        if (input[i + 1] === undefined)
          return { args: [], reason: "실행 옵션의 값이 없습니다." };
        args.push(input[++i]);
      }
    } else if (flags.has(key) && equal < 0) args.push(raw);
    else if (
      agent === "codex" &&
      /^-[acmpsC].+/.test(raw) &&
      !raw.startsWith("--")
    ) {
      if (raw[1] !== "C") args.push(raw);
    } else
      return {
        args: [],
        reason: `자동 복원을 지원하지 않는 실행 옵션입니다: ${key.slice(0, 80)}`,
      };
  }
  if (Buffer.byteLength(JSON.stringify(args)) > 8192)
    return { args: [], reason: "실행 옵션이 복원 저장 한도를 넘었습니다." };
  return { args };
}
export function agentResumeCommand(value: AgentResume): string[] | undefined {
  if (!value.running || !value.session || value.reason) return;
  if (value.hasConversation === false)
    return value.agent === "codex"
      ? [...value.args, "--cd", value.cwd]
      : [...value.args];
  return value.agent === "codex"
    ? [...value.args, "resume", value.session, "--cd", value.cwd]
    : [...value.args, "--resume", value.session];
}

export async function agentResumeProblem(value: AgentResume) {
  if (
    value.running &&
    value.hasConversation !== false &&
    value.transcript &&
    value.agent === "claude"
  ) {
    try {
      const stat = await fs.stat(value.transcript);
      if (stat.isFile() && stat.size > 0) return;
    } catch {
      // The CLI's reported transcript is authoritative; never guess another ID.
    }
    return "Claude 대화 파일을 찾을 수 없어 자동 재개를 생략했습니다. 대화 저장 위치와 파일 삭제 여부를 확인하세요.";
  }
}
