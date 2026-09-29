import type { Client, ClientChannel } from "ssh2";

export function parseRemoteOS(output: string): string | undefined {
  const clean = output.replace(/\r/g, "");
  const pretty = clean.match(
    /^(?:PRETTY_NAME|DISTRIB_DESCRIPTION)=["']?([^\n"']+)/m,
  )?.[1];
  if (pretty) return pretty.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256);
  const release = clean
    .split("\n")
    .find((line) =>
      /^(CentOS|Red Hat|Rocky|Alpine|Ubuntu|Debian|Fedora)\b/i.test(line),
    );
  if (release) return release.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256);
  if (/Microsoft Windows|Windows_NT/i.test(clean)) return "Windows";
  if (/^Darwin$/m.test(clean)) return "macOS";
  if (/^Linux$/m.test(clean)) return "Linux";
  if (/^FreeBSD$/m.test(clean)) return "FreeBSD";
}

// Use a separate, bounded read-only channel; never write a probe into the user's shell.
function probe(client: Client, command: string): Promise<string> {
  return new Promise((resolve) => {
    let data = "",
      channel: ClientChannel | undefined,
      done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.removeListener("close", finish);
      channel?.close();
      resolve(data);
    };
    const timer = setTimeout(finish, 2000);
    client.once("close", finish);
    try {
      client.exec(command, (error, stream) => {
        if (error) {
          finish();
          return;
        }
        channel = stream;
        if (done) {
          stream.close();
          return;
        }
        stream.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf8");
          if (data.length >= 8192) {
            data = data.slice(0, 8192);
            finish();
          }
        });
        stream.stderr.resume();
        stream.once("error", finish);
        stream.once("close", finish);
      });
    } catch {
      finish();
    }
  });
}
export async function detectRemoteOS(
  client: Client,
): Promise<string | undefined> {
  const unix = await probe(
    client,
    "uname -s; cat /etc/os-release /etc/lsb-release /etc/redhat-release 2>/dev/null",
  );
  const detected = parseRemoteOS(unix);
  if (detected) return detected;
  return parseRemoteOS(await probe(client, "cmd /c ver"));
}
