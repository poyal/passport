import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { LocalShell, Workspace } from "../shared/model";
import {
  selectedProfiles,
  type AppliedEnvironment,
  type TerminalSettings,
  type NotificationSettings,
  type StartupProfile,
  type ShellId,
} from "../shared/terminal-config";
import { resolvedShell, helperPath, bashPath } from "./shells";
import { localTerminalEnv } from "./terminal-env";

export const shQuote = (value: string) =>
  "'" + value.split("'").join("'\"'\"'") + "'";
export const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
export const bashFile = (file: string) =>
  process.platform === "win32"
    ? file
        .replace(/\\/g, "/")
        .replace(
          /^([A-Za-z]):/,
          (_, drive: string) => `/${drive.toLowerCase()}`,
        )
    : file;
export type LaunchSpec = {
  executable: string;
  args: string[] | string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  snapshot: AppliedEnvironment;
  cleanup: () => void;
};
export function previewEnvironment(
  config: LocalShell,
  settings: TerminalSettings,
  workspace?: Workspace,
): AppliedEnvironment {
  const shell = resolvedShell(config.shell);
  const cwd = config.cwd || workspace?.project?.cwd || os.homedir();
  if (shell.id === "cmd" && cwd.startsWith("\\\\"))
    throw new Error(
      "cmd는 UNC 시작 폴더를 지원하지 않습니다. PowerShell 또는 Passport Bash를 선택하세요.",
    );
  if (config.needsReview)
    throw new Error(
      "가져온 로컬 터미널입니다. 시작 폴더와 실행 설정을 확인한 뒤 다시 선택하세요.",
    );
  if (!fs.statSync(cwd).isDirectory())
    throw new Error("시작 폴더를 찾을 수 없습니다.");
  const profiles = selectedProfiles(
    settings,
    workspace?.project?.profiles,
    config.profiles,
  );
  const results: string[] = [];
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (
      !profile.platforms.includes(process.platform as "darwin") ||
      !profile.shells.includes(shell.id)
    )
      throw new Error(
        `${profile.name}: ${shell.name}에서 지원하지 않는 프로파일입니다.`,
      );
    for (const entry of profile.entries) {
      if (
        entry.kind === "path" &&
        entry.value.includes(process.platform === "win32" ? ";" : ":")
      )
        throw new Error("PATH 항목에 경로 구분자를 넣을 수 없습니다.");
      if (shell.id === "cmd")
        for (const value of [
          profile.name,
          ...(entry.kind === "alias"
            ? [entry.command, ...entry.args]
            : [entry.value]),
        ])
          cmdValue(value);
      const key =
        entry.kind === "path"
          ? `path:${entry.value}`
          : `${entry.kind}:${process.platform === "win32" ? entry.name.toLowerCase() : entry.name}`;
      results.push(
        `${profile.name} · ${key}${seen.has(key) ? (entry.kind !== "path" && entry.overwrite ? " (앞 항목 덮어쓰기)" : " (충돌 시 생략)") : ""}`,
      );
      seen.add(key);
    }
  }
  return {
    sessionInstanceId: randomUUID(),
    shell: shell.id,
    executable: shell.path,
    cwd,
    profiles: profiles.map(({ id, name, revision }) => ({
      id,
      name,
      revision,
    })),
    results,
    status: "starting",
    agent: config.agent,
  };
}
function unixEntries(profiles: StartupProfile[], helper: string) {
  const q = shQuote;
  const result = (label: string) => `${q(helper)} result ${q(label)}`;
  return profiles
    .flatMap((p) =>
      p.entries.map((e) => {
        const label = `${p.name} · ${e.kind === "path" ? e.value : e.name}`;
        if (e.kind === "alias") {
          const definition = `unalias ${q(e.name)} 2>/dev/null; function ${e.name}() { command ${[e.command, ...e.args].map(q).join(" ")} "$@"; }`;
          return `if ${e.overwrite ? "true" : `! type ${q(e.name)} >/dev/null 2>&1`}; then ${definition}; ${result(`${label}: 적용`)}; else ${result(`${label}: 기존 명령 유지`)}; fi`;
        }
        if (e.kind === "env")
          return `if ${e.overwrite ? "true" : `[ -z "\${${e.name}+x}" ]`}; then export ${e.name}=${q(e.value)}; ${result(`${label}: 적용`)}; else ${result(`${label}: 기존 값 유지`)}; fi`;
        const value = q(bashFile(e.value));
        return `case ":$PATH:" in *:${value}:*) ${result(`${label}: 중복 생략`)};; *) export PATH=${e.position === "prepend" ? `${value}:"$PATH"` : `"$PATH":${value}`}; ${result(`${label}: 적용`)};; esac`;
      }),
    )
    .join("\n");
}
function powershellEntries(profiles: StartupProfile[], helper: string) {
  const q = psQuote;
  const result = (label: string) => `& ${q(helper)} result ${q(label)}`;
  return profiles
    .flatMap((p) =>
      p.entries.map((e) => {
        const label = `${p.name} · ${e.kind === "path" ? e.value : e.name}`;
        if (e.kind === "alias")
          return `if (${e.overwrite ? "$true" : `-not (Get-Command ${q(e.name)} -ErrorAction SilentlyContinue)`}) { Remove-Item ${q(`Alias:${e.name}`)} -ErrorAction SilentlyContinue; function global:${e.name} { & ${[e.command, ...e.args].map(q).join(" ")} @args }; ${result(`${label}: 적용`)} } else { ${result(`${label}: 기존 명령 유지`)} }`;
        if (e.kind === "env")
          return `if (${e.overwrite ? "$true" : `-not (Test-Path Env:${e.name})`}) { $env:${e.name} = ${q(e.value)}; ${result(`${label}: 적용`)} } else { ${result(`${label}: 기존 값 유지`)} }`;
        return `if (($env:PATH -split ';') -notcontains ${q(e.value)}) { $env:PATH = ${e.position === "prepend" ? `${q(e.value + ";")} + $env:PATH` : `$env:PATH + ${q(";" + e.value)}`}; ${result(`${label}: 적용`)} } else { ${result(`${label}: 중복 생략`)} }`;
      }),
    )
    .join("\r\n");
}
// cmd expands percent expressions even inside double quotes. Delayed expansion
// is disabled for this launch, and unrepresentable quote/newline input is rejected.
export function cmdValue(value: string) {
  if (/["\r\n\0]/.test(value))
    throw new Error(
      "cmd 프로파일 값에는 큰따옴표나 줄바꿈을 넣을 수 없습니다.",
    );
  return value.replace(/%/g, "%%");
}
function cmdEntries(profiles: StartupProfile[], helper: string) {
  const lines: string[] = [];
  for (const profile of profiles)
    for (const e of profile.entries) {
      const label = `${profile.name} · ${e.kind === "path" ? e.value : e.name}`;
      const result = (text: string) =>
        `"${cmdValue(helper)}" result "${cmdValue(label + ": " + text)}"`;
      if (e.kind === "env")
        lines.push(
          `if ${e.overwrite ? "1==1" : `not defined ${e.name}`} (\r\nset "${e.name}=${cmdValue(e.value)}"\r\n${result("적용")}\r\n) else (\r\n${result("기존 값 유지")}\r\n)`,
        );
      else if (e.kind === "path")
        lines.push(
          `"${cmdValue(helper)}" path-contains "${cmdValue(e.value)}"\r\nif errorlevel 1 (\r\nset "PATH=${e.position === "prepend" ? `${cmdValue(e.value)};%PATH%` : `%PATH%;${cmdValue(e.value)}`}"\r\n${result("적용")}\r\n) else (\r\n${result("중복 생략")}\r\n)`,
        );
      else {
        // Native helper preserves existing macros and escapes doskey placeholders.
        lines.push(
          `"${cmdValue(helper)}" macro "${cmdValue(e.name)}" "${cmdValue(e.command)}" ${e.overwrite ? "1" : "0"} ${e.args.map((a) => `"${cmdValue(a)}"`).join(" ")}`,
        );
      }
    }
  return lines.join("\r\n");
}
export function prepareLaunch(
  config: LocalShell,
  settings: TerminalSettings,
  notifications: NotificationSettings,
  workspace: Workspace | undefined,
  root: string,
  credentials: Record<string, string>,
  snapshot = previewEnvironment(config, settings, workspace),
): LaunchSpec {
  const profiles = selectedProfiles(
    settings,
    workspace?.project?.profiles,
    config.profiles,
  );
  const env: NodeJS.ProcessEnv = {
    ...localTerminalEnv(),
    ...credentials,
  };
  env.PASSPORT_INIT_FAILED = "0";
  if (
    process.platform === "win32" &&
    fs.existsSync(bashPath()) &&
    !env.CLAUDE_CODE_GIT_BASH_PATH
  )
    env.CLAUDE_CODE_GIT_BASH_PATH = bashPath();
  if (snapshot.shell === "passport-bash") {
    env.MSYSTEM = process.arch === "arm64" ? "CLANGARM64" : "MINGW64";
    env.CHERE_INVOKING = "1";
  }
  if (!profiles.length && !config.agent) {
    // A plain shell needs no loader or execution-policy exception. In particular,
    // Bash keeps its native login/logout semantics when injection is disabled.
    snapshot.status = "ready";
    return {
      executable: snapshot.executable,
      args:
        snapshot.shell === "cmd"
          ? []
          : ["pwsh", "windows-powershell"].includes(snapshot.shell)
            ? ["-NoLogo"]
            : ["-l"],
      cwd: snapshot.cwd,
      env,
      snapshot,
      cleanup: () => {},
    };
  }
  const helper = helperPath();
  if (!fs.existsSync(helper))
    throw new Error(
      "Passport helper가 없습니다. 앱을 다시 설치하거나 npm run build:helper를 실행하세요.",
    );
  const directory = path.join(root, snapshot.sessionInstanceId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write = (name: string, text: string) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, text, { mode: 0o600 });
    return file;
  };
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  const integration = profiles.some(
    (p) => p.integration === "ai-notifications",
  );
  env.PASSPORT_CLAUDE = integration && notifications.claude ? "1" : "0";
  env.PASSPORT_CODEX = integration && notifications.codex ? "1" : "0";
  // Hook command text stays stable across runs; credentials only travel via the
  // inherited environment. Claude user settings and trust decisions are untouched.
  const hooks = Object.fromEntries(
    [
      "Stop",
      "PermissionRequest",
      "Notification",
      "UserPromptSubmit",
      "PostToolUse",
      "PostToolUseFailure",
      "StopFailure",
      "SessionEnd",
    ].map((name) => [
      name,
      [
        {
          hooks: [
            {
              type: "command",
              command: helper,
              args: ["claude-hook"],
              timeout: 1,
            },
          ],
        },
      ],
    ]),
  );
  env.PASSPORT_CLAUDE_SETTINGS = write(
    "claude-settings.json",
    JSON.stringify({ hooks }),
  );
  if (
    process.platform === "win32" &&
    fs.existsSync(bashPath()) &&
    !env.CLAUDE_CODE_GIT_BASH_PATH
  )
    env.CLAUDE_CODE_GIT_BASH_PATH = bashPath();
  const shell = snapshot.shell;
  let args: string[] | string;
  if (shell === "bash" || shell === "zsh" || shell === "passport-bash") {
    const helperUnix = bashFile(helper);
    const q = shQuote;
    let body = unixEntries(profiles, helperUnix) + "\n";
    for (const agent of ["claude", "codex"] as const)
      if (integration && notifications[agent])
        body += `unalias ${agent} 2>/dev/null\nfunction ${agent}() { ${q(helperUnix)} run ${agent} "$@"; }\n`;
    body += `${q(helperUnix)} ready\n`;
    if (config.agent) body += `${q(helperUnix)} run ${config.agent}\n`;
    body = `if [ "$PASSPORT_INIT_FAILED" != 1 ]; then\n${body}else\n${q(helperUnix)} result '!error:사용자 시작 파일에서 오류가 발생했습니다. AI 자동 실행을 생략했습니다.'\nfi\n`;
    if (shell === "zsh") {
      // Keep the original ZDOTDIR while sourcing each user file. Capture changes
      // made by .zshenv and restore them before the first prompt / nested shells.
      env.PASSPORT_USER_ZDOTDIR = env.ZDOTDIR || os.homedir();
      env.PASSPORT_HAD_ZDOTDIR = env.ZDOTDIR === undefined ? "0" : "1";
      env.ZDOTDIR = directory;
      const bridge = (file: string, final = false) =>
        `ZDOTDIR="$PASSPORT_USER_ZDOTDIR"\nif [[ -r "$ZDOTDIR/${file}" ]]; then\nif ${q(snapshot.executable)} -f -n "$ZDOTDIR/${file}"; then source "$ZDOTDIR/${file}" || ${q(helperUnix)} result ${q(`${file}: 마지막 명령이 0이 아닌 상태로 끝났습니다.`)}; else PASSPORT_INIT_FAILED=1; fi\nfi\nPASSPORT_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"\n${final ? 'if [[ "$PASSPORT_HAD_ZDOTDIR" == 0 && "$PASSPORT_USER_ZDOTDIR" == "$HOME" ]]; then unset ZDOTDIR; else ZDOTDIR="$PASSPORT_USER_ZDOTDIR"; fi' : `ZDOTDIR=${q(directory)}`}\n`;
      write(".zshenv", bridge(".zshenv"));
      write(".zprofile", bridge(".zprofile"));
      write(".zshrc", bridge(".zshrc"));
      write(".zlogin", bridge(".zlogin", true) + body);
      args = ["-l", "-i"];
    } else {
      // --rcfile is an interactive shell. Emulate login initialization once,
      // retaining Bash 3.2 and Git for Windows startup order without home writes.
      const read = (file: string) =>
        `if ${q(bashFile(snapshot.executable))} --noprofile --norc -n "${file}"; then . "${file}" || ${q(helperUnix)} result '시작 파일: 마지막 명령이 0이 아닌 상태로 끝났습니다.'; else PASSPORT_INIT_FAILED=1; fi`;
      const init = `if [ -r /etc/profile ]; then ${read("/etc/profile")}; fi\nif [ -r "$HOME/.bash_profile" ]; then ${read("$HOME/.bash_profile")}; elif [ -r "$HOME/.bash_login" ]; then ${read("$HOME/.bash_login")}; elif [ -r "$HOME/.profile" ]; then ${read("$HOME/.profile")}; ${shell === "passport-bash" ? `elif [ -r "$HOME/.bashrc" ]; then ${read("$HOME/.bashrc")}; ` : ""}fi\n`;
      const loader = write("startup.bash", init + body);
      if (shell === "passport-bash") {
        env.MSYSTEM = process.arch === "arm64" ? "CLANGARM64" : "MINGW64";
        env.CHERE_INVOKING = "1";
      }
      args = ["--rcfile", bashFile(loader), "-i"];
    }
  } else if (shell === "pwsh" || shell === "windows-powershell") {
    let body = powershellEntries(profiles, helper) + "\r\n";
    for (const agent of ["claude", "codex"] as const)
      if (integration && notifications[agent])
        body += `function global:${agent} { & ${psQuote(helper)} run ${agent} @args }\r\n`;
    body += `& ${psQuote(helper)} ready\r\n`;
    if (config.agent) body += `& ${psQuote(helper)} run ${config.agent}\r\n`;
    const file = write(
      "startup.ps1",
      "\ufeff" +
        `if ($Error.Count -gt 0) { & ${psQuote(helper)} result '!error:PowerShell 사용자 프로파일 오류를 확인하세요. AI 자동 실행을 생략했습니다.'; return }\r\n` +
        body,
    );
    args = ["-NoLogo", "-NoExit", "-Command", `. ${psQuote(file)}`];
  } else if (shell === "cmd") {
    let body =
      "@echo off\r\nchcp 65001 >nul\r\n" +
      cmdEntries(profiles, helper) +
      "\r\n";
    for (const agent of ["claude", "codex"] as const)
      if (integration && notifications[agent])
        body += `"${cmdValue(helper)}" macro ${agent} "${cmdValue(helper)}" 1 run ${agent}\r\n`;
    body += `"${cmdValue(helper)}" ready\r\n`;
    if (config.agent) body += `"${cmdValue(helper)}" run ${config.agent}\r\n`;
    const file = write("startup.cmd", body);
    env.PASSPORT_STARTUP = file;
    // cmd parses its own quotes. node-pty's argv escaping uses backslashes,
    // which cmd treats as literal characters instead of quote escapes.
    args = '/v:off /s /k ""%PASSPORT_STARTUP%""';
  } else {
    if (profiles.length || config.agent)
      throw new Error(
        "이 로그인 셸은 프로파일·AI 실행을 지원하지 않습니다. zsh 또는 bash를 선택하세요.",
      );
    args = ["-l"];
    snapshot.status = "ready";
  }
  return {
    executable: snapshot.executable,
    cwd: snapshot.cwd,
    args,
    env,
    snapshot,
    cleanup,
  };
}
