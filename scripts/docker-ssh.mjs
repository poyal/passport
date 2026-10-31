import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
const args = process.argv.slice(2);
if (args[0] === "--cleanup") {
  if (args.length !== 2) throw new Error("Use --cleanup <manifest.json>");
  const manifest = path.resolve(args[1]);
  const fixture = JSON.parse(await fs.readFile(manifest, "utf8"));
  if (fixture.owner !== "passport-docker-fixture-v1")
    throw new Error("Not an owned fixture manifest");
  const directory = await fs.realpath(path.dirname(manifest));
  if (
    path.dirname(directory).toLowerCase() !==
      (await fs.realpath(os.tmpdir())).toLowerCase() ||
    !path.basename(directory).startsWith("passport-docker-")
  )
    throw new Error(
      "Refusing cleanup outside an owned temporary fixture directory",
    );
  for (const host of fixture.hosts) {
    if (!/^passport-ssh-[a-z0-9-]+-\d+$/.test(host.container))
      throw new Error("Unexpected fixture container name");
    const label = execFileSync(
      "docker",
      [
        "inspect",
        "--format",
        '{{ index .Config.Labels "io.passport.test" }}',
        host.container,
      ],
      { encoding: "utf8" },
    ).trim();
    if (label !== "ssh")
      throw new Error("Refusing to remove an unlabelled container");
    execFileSync("docker", ["rm", "-f", host.container], { stdio: "ignore" });
  }
  // Only the manifest's own generated credential directory is reclaimed.
  await fs.rm(directory, { recursive: true, force: true });
  console.log(
    "Removed the manifest's Passport SSH fixture containers and temporary credentials.",
  );
  process.exit(0);
}
if (args.some((arg) => arg !== "--prepare") || args.length > 1)
  throw new Error("Use --prepare, --cleanup <manifest.json>, or no arguments");
const prepareOnly = args.includes("--prepare");
const matrix = [
  ["alpine", "alpine:3.22"],
  ["ubuntu", "ubuntu:24.04"],
  ["debian", "debian:12"],
  ["rocky", "rockylinux:9"],
  ["centos", "quay.io/centos/centos:stream9"],
  ["centos7", "centos:7"],
  ["centos7-group1", "centos:7", "diffie-hellman-group1-sha1"],
  ["centos7-gex-sha1", "centos:7", "diffie-hellman-group-exchange-sha1"],
];
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-docker-"));
const containers = [];
let retained = false;
const resultsPath =
  process.env.PASSPORT_DOCKER_RESULTS ||
  "release/checks/docker-ssh/results.json";
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
  if (!prepareOnly && !process.env.PASSPORT_E2E_EXECUTABLE)
    await run(process.execPath, ["scripts/build.mjs"]);
  const architecture = execFileSync(
    "docker",
    ["info", "--format", "{{.Architecture}}"],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  ).trim();
  const dockerArch = {
    x86_64: "amd64",
    amd64: "amd64",
    aarch64: "arm64",
    arm64: "arm64",
  }[architecture];
  if (!dockerArch)
    throw new Error(`Unsupported Docker architecture: ${architecture}`);
  const dockerPlatform = `linux/${dockerArch}`;
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
  for (const [id, base, legacyKex] of matrix) {
    const image = `passport-ssh-test:${id}`,
      name = `passport-ssh-${id}-${process.pid}`;
    console.log(`\n[Passport SSH] ${id}: ${base}`);
    await run("docker", [
      "build",
      "--platform",
      dockerPlatform,
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
      ...(legacyKex ? ["-e", `PASSPORT_TEST_LEGACY_KEX=${legacyKex}`] : []),
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
      legacyKex,
    });
  }
  const manifest = path.join(directory, "manifest.json");
  await fs.writeFile(
    manifest,
    JSON.stringify({
      owner: "passport-docker-fixture-v1",
      dockerPlatform,
      hosts,
      password,
      privateKey,
      passphrase: "passport-test-key",
    }),
    { mode: 0o600 },
  );
  if (prepareOnly) {
    retained = true;
    console.log(
      `Passport SSH fixtures ready. PASSPORT_DOCKER_MANIFEST=${manifest}`,
    );
    console.log(
      "Reuse this manifest for source and packaged verification; then run --cleanup with the same path.",
    );
  } else {
    await run(
      process.execPath,
      ["scripts/test.mjs", "tests/docker-ssh.test.ts"],
      {
        env: {
          ...process.env,
          PASSPORT_DOCKER_MANIFEST: manifest,
          PASSPORT_DOCKER_RESULTS: resultsPath,
        },
      },
    );
    await run(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "tests/e2e/docker-ssh.spec.ts",
        "--output=" +
          (process.env.PASSPORT_DOCKER_OUTPUT || "test-results/docker-ssh"),
      ],
      {
        env: {
          ...process.env,
          PASSPORT_DOCKER_MANIFEST: manifest,
          PASSPORT_DISABLE_UPDATE_CHECK: "1",
        },
      },
    );
  }
} finally {
  if (!retained) {
    for (const name of containers) {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      } catch {}
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
