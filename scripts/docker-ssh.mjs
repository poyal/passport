import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
const matrix = [
  ["alpine", "alpine:3.22"],
  ["ubuntu", "ubuntu:24.04"],
  ["debian", "debian:12"],
  ["rocky", "rockylinux:9"],
  ["centos", "quay.io/centos/centos:stream9"],
  ["centos7", "centos:7"],
];
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-docker-"));
const containers = [];
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
try {
  execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15000 });
  execFileSync("ssh-keygen", [
    "-t",
    "ed25519",
    "-N",
    "passport-test-key",
    "-f",
    path.join(directory, "id_ed25519"),
    "-q",
  ]);
  const privateKey = await fs.readFile(
      path.join(directory, "id_ed25519"),
      "utf8",
    ),
    publicKey = (
      await fs.readFile(path.join(directory, "id_ed25519.pub"), "utf8")
    ).trim();
  const password = randomBytes(24).toString("hex");
  const envFile = path.join(directory, "env");
  await fs.writeFile(
    envFile,
    `PASSPORT_TEST_PASSWORD=${password}\nPASSPORT_TEST_PUBLIC_KEY=${publicKey}\n`,
    { mode: 0o600 },
  );
  const hosts = [];
  for (const [id, base] of matrix) {
    const image = `passport-ssh-test:${id}`,
      name = `passport-ssh-${id}-${process.pid}`;
    console.log(`\n[Passport SSH] ${id}: ${base}`);
    await run("docker", [
      "build",
      "--platform",
      "linux/arm64",
      "--build-arg",
      `BASE_IMAGE=${base}`,
      "-t",
      image,
      "tests/docker",
    ]);
    await run("docker", [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "io.passport.test=ssh",
      "--env-file",
      envFile,
      "-p",
      "127.0.0.1::22",
      image,
    ]);
    containers.push(name);
    const binding = execFileSync("docker", ["port", name, "22/tcp"], {
      encoding: "utf8",
    }).trim();
    hosts.push({
      name: id,
      image: base,
      port: Number(binding.split(":").at(-1)),
      container: name,
    });
  }
  const manifest = path.join(directory, "manifest.json");
  await fs.writeFile(
    manifest,
    JSON.stringify({
      hosts,
      password,
      privateKey,
      passphrase: "passport-test-key",
    }),
    { mode: 0o600 },
  );
  await run(
    process.execPath,
    ["scripts/test.mjs", "tests/docker-ssh.test.ts"],
    { env: { ...process.env, PASSPORT_DOCKER_MANIFEST: manifest } },
  );
} finally {
  for (const name of containers) {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {}
  }
  await fs.rm(directory, { recursive: true, force: true });
}
