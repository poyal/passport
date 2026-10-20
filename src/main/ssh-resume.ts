import { randomUUID } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
// Consume only metadata for this connection; all other terminal sequences pass
// through unchanged, including split OSCs and notifications.
export class ResumeOutput {
  private pending = "";
  constructor(
    private nonce: string,
    private receive: (kind: string, value: string) => void,
  ) {}
  push(chunk: string) {
    this.pending += chunk;
    let output = "";
    while (this.pending) {
      const start = this.pending.indexOf("\x1b]");
      if (start < 0) {
        const tail = this.pending.endsWith("\x1b") ? 1 : 0;
        output += this.pending.slice(0, this.pending.length - tail);
        this.pending = tail ? "\x1b" : "";
        break;
      }
      output += this.pending.slice(0, start);
      this.pending = this.pending.slice(start);
      const end = /\x07|\x1b\\/.exec(this.pending.slice(2));
      if (!end) {
        if (this.pending.length > 8192) {
          output += this.pending;
          this.pending = "";
        }
        break;
      }
      const length = 2 + end.index + end[0].length;
      const value = this.pending.slice(2, 2 + end.index);
      const match = /^777;passport-(cwd|ready|warning);([^;]+);([\s\S]*)$/.exec(
        value,
      );
      if (match && match[2] === this.nonce) {
        if (match[3].length <= 4096 && !/[\0\r\n\x1b]/.test(match[3]))
          this.receive(match[1], match[3]);
      } else output += this.pending.slice(0, length);
      this.pending = this.pending.slice(length);
    }
    return output;
  }
  end() {
    const value = this.pending;
    this.pending = "";
    return value;
  }
}
function execSmall(
  client: Client,
  command: string,
  timeout = 2000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined,
      done = false,
      output = "";
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel?.close();
      error ? reject(error) : resolve(output);
    };
    const timer = setTimeout(
      () => finish(new Error("SSH 셸 준비 시간이 초과되었습니다.")),
      timeout,
    );
    client.exec(command, (error, stream) => {
      if (error) {
        finish(error);
        return;
      }
      channel = stream;
      if (done) {
        stream.close();
        return;
      }
      stream.on("data", (data: Buffer) => {
        output += data.toString("utf8");
        if (Buffer.byteLength(output) > 8192)
          finish(new Error("SSH 셸 준비 응답이 너무 큽니다."));
      });
      stream.stderr.resume();
      stream.on("error", finish);
      stream.once("close", (code: number) =>
        finish(code ? new Error("SSH 셸 준비에 실패했습니다.") : undefined),
      );
    });
  });
}
export function remoteResumeFiles(
  shell: "bash" | "zsh",
  nonce: string,
  cwd?: string,
): Record<string, string> {
  const signal = (kind: string, value: string) =>
    `printf '\\033]777;passport-${kind};${nonce};%s\\007' ${value}`;
  const restore = cwd
    ? `cd -- ${quote(cwd)} 2>/dev/null || ${signal("warning", quote("이전 작업 폴더를 열 수 없어 기본 폴더로 연결했습니다."))}\n`
    : "";
  const prompt = `__passport_cwd() { local passport_status=$?; ${signal("cwd", '"$PWD"')}; return $passport_status; }\n`;
  const body =
    restore +
    prompt +
    (shell === "bash"
      ? `if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then PROMPT_COMMAND+=(__passport_cwd); else PROMPT_COMMAND="__passport_cwd\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi\n`
      : "autoload -Uz add-zsh-hook\nadd-zsh-hook precmd __passport_cwd\n") +
    signal("ready", "1") +
    "\n";
  if (shell === "bash")
    return {
      "startup.bash": `if [ -r /etc/profile ]; then . /etc/profile; fi\nif [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"; elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"; elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"; fi\n${body}`,
    };
  const bridge = (file: string, final = false) =>
    `ZDOTDIR="$PASSPORT_REMOTE_ZDOTDIR"\n[[ ! -r "$ZDOTDIR/${file}" ]] || source "$ZDOTDIR/${file}"\nPASSPORT_REMOTE_ZDOTDIR="\${ZDOTDIR:-$HOME}"\n${final ? 'if [[ "$PASSPORT_REMOTE_HAD_ZDOTDIR" != 1 && "$PASSPORT_REMOTE_ZDOTDIR" == "$HOME" ]]; then unset ZDOTDIR; else ZDOTDIR="$PASSPORT_REMOTE_ZDOTDIR"; fi' : 'ZDOTDIR="$PASSPORT_REMOTE_LOADER"'}\n`;
  return {
    ".zshenv": bridge(".zshenv"),
    ".zprofile": bridge(".zprofile"),
    ".zshrc": bridge(".zshrc"),
    ".zlogin": bridge(".zlogin", true) + body,
  };
}
export async function prepareRemoteResume(client: Client, cwd?: string) {
  const detection = await execSmall(
    client,
    `sh -c ${quote('printf "\\nPASSPORT_SHELL:%s\\n" "$SHELL"')}`,
  );
  const executable = /^PASSPORT_SHELL:(\/[^\r\n\0]+\/(?:bash|zsh))$/m.exec(
    detection,
  )?.[1];
  if (!executable)
    throw new Error(
      "이 서버의 셸은 작업 폴더 복원을 지원하지 않습니다. Bash·zsh에서 사용할 수 있습니다.",
    );
  const shell = executable.endsWith("/zsh") ? "zsh" : "bash",
    nonce = randomUUID();
  const files = remoteResumeFiles(shell, nonce, cwd);
  const setup =
    'umask 077\nd=$(mktemp -d "${TMPDIR:-/tmp}/passport-session.XXXXXXXX") || exit 1\n' +
    Object.entries(files)
      .map(
        ([name, contents]) =>
          `printf %s ${quote(contents)} > "$d/${name}" || exit 1`,
      )
      .join("\n") +
    '\nprintf "\\nPASSPORT_DIR:%s\\n" "$d"\n';
  const prepared = await execSmall(client, `sh -c ${quote(setup)}`);
  const directory =
    /^PASSPORT_DIR:(\/[^\r\n\0]*\/passport-session\.[A-Za-z0-9]+)$/m.exec(
      prepared,
    )?.[1];
  if (!directory) throw new Error("서버에 임시 셸 환경을 준비하지 못했습니다.");
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await execSmall(
      client,
      `rm -f -- ${Object.keys(files)
        .map((name) => quote(directory + "/" + name))
        .join(" ")} && rmdir -- ${quote(directory)}`,
    ).catch(() => {});
  };
  const command =
    shell === "bash"
      ? `exec ${quote(executable)} --rcfile ${quote(directory + "/startup.bash")} -i`
      : `PASSPORT_REMOTE_ZDOTDIR="\${ZDOTDIR:-$HOME}" PASSPORT_REMOTE_HAD_ZDOTDIR="\${ZDOTDIR+1}" PASSPORT_REMOTE_LOADER=${quote(directory)} ZDOTDIR=${quote(directory)} exec ${quote(executable)} -l -i`;
  return { command, nonce, cleanup };
}
