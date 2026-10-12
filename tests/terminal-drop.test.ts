import { test, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareTerminalDrop } from "../src/main/terminal-drop";
import { prepareTerminalClipboard } from "../src/main/terminal-clipboard";

test("file and folder drops use clipboard path quoting without copies or Enter", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-drop-"));
  try {
    const names = [
      "한 글.png",
      "a'b.JPG",
      "{{literal}} $`!%.md",
      "첨부.pdf",
      "자료.zip",
      "확장자없음",
      "빈 파일.txt",
      "프로젝트 폴더",
    ];
    const paths = names.map((name) => path.join(directory, name));
    for (const file of paths.slice(0, -2)) await fs.writeFile(file, "fixture");
    await fs.writeFile(paths.at(-2)!, "");
    await fs.mkdir(paths.at(-1)!);
    for (const shell of [
      "zsh",
      "bash",
      "passport-bash",
      "pwsh",
      "windows-powershell",
    ] as const) {
      const clipboard = await prepareTerminalClipboard({
        read: async () => [],
        readNativeFiles: async () => paths,
        toPNG: () => {
          throw new Error("File paths must not decode image contents");
        },
        userData: directory,
        platform: process.platform,
        shell,
        check: () => {},
      });
      expect(clipboard.kind).toBe("files");
      if (clipboard.kind !== "files")
        throw new Error("Expected clipboard file paths");
      const text = await prepareTerminalDrop({
        paths,
        shell,
        platform: process.platform,
        check: () => {},
      });
      expect(text).toBe(` ${clipboard.text} `);
      expect(text).not.toMatch(/[\r\n\x1b]/);
    }
    expect((await fs.readdir(directory)).sort()).toEqual(names.sort());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("file drops reject invalid path batches or a changed session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-drop-"));
  const good = path.join(directory, "good.png");
  const options = {
    paths: [good],
    shell: "zsh" as const,
    platform: process.platform,
    check: () => {},
  };
  try {
    await fs.writeFile(good, "image fixture");
    for (const paths of [
      [],
      ["relative.png"],
      [good, path.join(directory, "line\n.md")],
      Array(1001).fill(good),
      Array(50).fill("/" + "한".repeat(30000) + ".png"),
    ])
      await expect(
        prepareTerminalDrop({ ...options, paths }),
      ).rejects.toThrow();
    let checks = 0;
    await expect(
      prepareTerminalDrop({
        ...options,
        check: () => {
          if (++checks === 2) throw new Error("changed session");
        },
      }),
    ).rejects.toThrow("changed session");
    await expect(
      prepareTerminalDrop({
        ...options,
        paths: [path.join(directory, "unsafe%.png")],
        shell: "cmd",
      }),
    ).rejects.toThrow("PowerShell");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
