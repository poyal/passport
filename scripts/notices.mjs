import {
  readFile,
  readdir,
  writeFile,
  mkdir,
  copyFile,
  access,
  cp,
} from "node:fs/promises";
import path from "node:path";
const root = process.cwd(),
  seen = new Set(),
  rows = [];
await mkdir("dist/licenses", { recursive: true });
await cp("licenses/fonts", "dist/licenses/fonts", { recursive: true });
await cp("licenses/themes", "dist/licenses/themes", { recursive: true });
await cp("licenses/os-icons", "dist/licenses/os-icons", { recursive: true });
async function locate(name, from) {
  let current = from;
  while (true) {
    const p = path.join(current, "node_modules", name);
    try {
      await access(path.join(p, "package.json"));
      return p;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
async function visit(name, from) {
  const directory = await locate(name, from);
  if (!directory || seen.has(directory)) return;
  seen.add(directory);
  const p = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  const key = `${p.name.replace(/[@/]/g, "_")}-${p.version}`;
  const files = (await readdir(directory)).filter((f) =>
    /^(licen[cs]e|copying|notice|ofl)(\.|-|$)/i.test(f),
  );
  for (const f of files) {
    try {
      await copyFile(
        path.join(directory, f),
        path.join("dist/licenses", `${key}-${f}`),
      );
    } catch {}
  }
  rows.push(
    `| ${p.name} | ${p.version} | ${typeof p.license === "string" ? p.license : "패키지 고지 참조"} |`,
  );
  for (const dep of Object.keys({
    ...p.dependencies,
    ...p.optionalDependencies,
  }))
    await visit(dep, directory);
}
const app = JSON.parse(await readFile("package.json", "utf8"));
for (const name of Object.keys(app.dependencies)) await visit(name, root);
await writeFile(
  "dist/licenses/DEPENDENCIES.md",
  "# 포함된 라이브러리\n\n각 저작권과 라이선스 원문은 같은 폴더에 보관합니다. Electron 자체의 LICENSE와 Chromium 고지는 설치본에 함께 배포됩니다.\n\n| 라이브러리 | 버전 | 라이선스 |\n| --- | --- | --- |\n" +
    rows.sort().join("\n") +
    "\n\nssh2 1.17.0의 DH group1 구현은 Electron/BoringSSL 호환을 위해 RFC 2409 §6.2의 동일한 소수를 명시적으로 지정하도록 수정했습니다. Passport는 현대 키 교환을 우선하며 SHA-1 group14·GEX·group1을 기본 목록 뒤에 추가해 구형 서버를 지원합니다. 패치는 scripts/patch-ssh2.mjs에서 관리합니다.\n",
);
