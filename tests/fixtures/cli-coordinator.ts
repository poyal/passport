import { expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
const bashPath = (value: string) =>
  process.platform === "win32"
    ? value
        .replace(/\\/g, "/")
        .replace(
          /^([A-Za-z]):/,
          (_, drive: string) => `/${drive.toLowerCase()}`,
        )
    : value;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const input = (page: Page, id: string, data: string) =>
  page.evaluate(
    ({ id, data }) => window.passport.call("session.input", { id, data }),
    { id, data },
  );
export async function cliCoordinator(page: Page, paneId: string, root: string) {
  const directory = path.join(root, randomUUID());
  await fs.mkdir(directory);
  const script = path.join(directory, "coordinator.cjs");
  const request = path.join(directory, "request.json");
  const response = path.join(directory, "response.json");
  const ready = path.join(directory, "ready");
  await fs.writeFile(
    script,
    `
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const request = ${JSON.stringify(request)}, response = ${JSON.stringify(response)};
let last, busy = false;
fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
setInterval(() => {
  if (busy) return;
  let job; try { job = JSON.parse(fs.readFileSync(request, 'utf8')); } catch { return; }
  if (job.id === last) return;
  last = job.id; busy = true;
  const child = execFile(process.platform === 'win32' ? 'passport.exe' : 'passport', job.args,
    { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
    (error, stdout, stderr) => {
      fs.writeFileSync(response, JSON.stringify({ id: job.id, code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
      busy = false;
    });
  child.stdin.end(job.stdin || '');
}, 25);
`,
  );
  await input(
    page,
    paneId,
    `${quote(bashPath(process.execPath))} ${quote(bashPath(script))}\r`,
  );
  await expect
    .poll(() => fs.readFile(ready, "utf8").catch(() => ""))
    .toBe("ready");
  return async (args: string[], stdin?: string) => {
    const id = randomUUID();
    await fs.writeFile(
      request,
      JSON.stringify({ id, args: [...args, "--json"], stdin }),
    );
    let result:
      { id: string; code: number; stdout: string; stderr: string } | undefined;
    await expect
      .poll(
        async () => {
          try {
            result = JSON.parse(await fs.readFile(response, "utf8"));
            return result?.id;
          } catch {
            return undefined;
          }
        },
        { timeout: 10000 },
      )
      .toBe(id);
    return { code: result!.code, ...JSON.parse(result!.stdout) };
  };
}
