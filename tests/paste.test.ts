import { test, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { PasteQueue, quotePastePaths } from "../src/shared/paste";
import {
  decodeDropFiles,
  decodeFileURLs,
  readClipboardFiles,
  validateFilePaths,
  osClipboardFormat,
  readMacClipboardFiles,
} from "../src/main/clipboard-files";
import {
  writeMacPasteboard,
  releaseMacPasteboard,
} from "./fixtures/mac-pasteboard";
import { prepareTerminalClipboard } from "../src/main/terminal-clipboard";

const item = (values: Record<string, string | Uint8Array>) => ({
  types: Object.keys(values),
  getType: async (type: string) =>
    new Blob([
      typeof values[type] === "string"
        ? values[type]
        : new Uint8Array(values[type]),
    ]),
});
const png = Buffer.from("89504e470d0a1a0a", "hex");
const options = (items: ReturnType<typeof item>[]) => ({
  read: async () => items,
  toPNG: () => png,
  userData: "",
  platform: "darwin",
  shell: "zsh" as const,
  check: () => {},
});

test("native file paths replace Finder display names without rewriting ordinary text or image input", async () => {
  const files = [
    "/Applications/Passport.app",
    "/Users/example/한글 폴더",
    "/tmp/a'b.txt",
  ];
  expect(
    await prepareTerminalClipboard({
      ...options([item({ "text/plain": "Passport.app\n한글 폴더\na'b.txt" })]),
      readNativeFiles: async () => files,
    }),
  ).toEqual({
    kind: "files",
    paths: files,
    text: quotePastePaths(files, "zsh"),
  });
  expect(
    await prepareTerminalClipboard({
      ...options([item({ "text/plain": "Passport.app" })]),
      readNativeFiles: async () => [],
    }),
  ).toEqual({ kind: "text", text: "Passport.app" });
  await expect(
    prepareTerminalClipboard({
      ...options([item({ "text/plain": "Passport.app" })]),
      shell: undefined,
      readNativeFiles: async () => files,
    }),
  ).rejects.toThrow("SSH");
});

test.skipIf(process.platform !== "darwin")(
  "native AppKit reads app, folder and multiple file URLs from an isolated pasteboard",
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "passport-native-files-"),
    );
    const name = `io.passport.test.${path.basename(directory)}`;
    try {
      const files = [
        path.join(directory, "Passport.app"),
        path.join(directory, "한 글 폴더"),
        path.join(directory, "a'b.txt"),
      ];
      await fs.mkdir(files[0]);
      await fs.mkdir(files[1]);
      await fs.writeFile(files[2], "fixture");
      await writeMacPasteboard(name, files);
      const nativeFiles = await readMacClipboardFiles(name);
      // AppKit may return decomposed Korean paths. Preserve those native bytes
      // in production and check that they actually refer to the same files.
      expect(nativeFiles.map((file) => file.normalize("NFC"))).toEqual(files);
      for (const file of nativeFiles) await fs.access(file);
      await writeMacPasteboard(name, []);
      expect(await readMacClipboardFiles(name)).toEqual([]);
    } finally {
      await releaseMacPasteboard(name);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test("paths remain literal shell arguments and unsafe cmd expansions are rejected", () => {
  const files = ["/tmp/한 글.png", "/tmp/a'b;$(echo BAD)`echo BAD`!.png"];
  const quoted = quotePastePaths(files, "bash");
  if (process.platform !== "win32") {
    expect(
      execFileSync("/bin/bash", [
        "--noprofile",
        "--norc",
        "-c",
        `printf '%s\\0' ${quoted}`,
      ])
        .toString()
        .split("\0")
        .slice(0, -1),
    ).toEqual(files);
  }
  expect(
    quotePastePaths(["C:\\한 글\\a'b.png", "\\\\server\\share\\x.png"], "pwsh"),
  ).toBe("'C:\\한 글\\a''b.png' '\\\\server\\share\\x.png'");
  expect(quotePastePaths(["C:\\한 글\\a.png"], "passport-bash")).toBe(
    "'C:/한 글/a.png'",
  );
  expect(quotePastePaths(["C:\\a & b.png"], "cmd")).toBe('"C:\\a & b.png"');
  for (const file of ["C:\\%TEMP%.png", "C:\\a!b.png", 'C:\\a"b.png'])
    expect(() => quotePastePaths([file], "cmd")).toThrow();
  expect(() => quotePastePaths(["/tmp/a\nb"], "bash")).toThrow();
  expect(() => quotePastePaths(["/tmp/a"], "default")).toThrow();
});

test("file URL and Windows DROPFILES adapters preserve multiple Unicode and UNC paths", async () => {
  expect(
    decodeFileURLs(
      "file:///tmp/%ED%95%9C%20%EA%B8%80.png\r\nfile:///tmp/a%23b.png",
      "darwin",
    ),
  ).toEqual(["/tmp/한 글.png", "/tmp/a#b.png"]);
  expect(
    decodeFileURLs("file:///C:/a%20b.png\nfile://server/share/a.png", "win32"),
  ).toEqual(["C:\\a b.png", "\\\\server\\share\\a.png"]);
  const files = ["C:\\한 글\\a.png", "\\\\server\\share\\b.png"];
  const header = Buffer.alloc(20);
  header.writeUInt32LE(20);
  header.writeUInt32LE(1, 16);
  const bytes = Buffer.concat([
    header,
    Buffer.from(files.join("\0") + "\0\0", "utf16le"),
  ]);
  expect(decodeDropFiles(bytes)).toEqual(files);
  expect(
    await readClipboardFiles(
      [item({ [osClipboardFormat("CF_HDROP")]: bytes, "text/plain": "wrong" })],
      "win32",
    ),
  ).toEqual(files);
  expect(() => decodeDropFiles(bytes.subarray(0, -2))).toThrow();
  expect(() => validateFilePaths(["relative.png"], "win32")).toThrow();
  expect(() => validateFilePaths(["C:relative.png"], "win32")).toThrow();
  expect(() => decodeFileURLs("file:///tmp/a%0Ab", "darwin")).not.toThrow();
  expect(() =>
    validateFilePaths(decodeFileURLs("file:///tmp/a%0Ab", "darwin"), "darwin"),
  ).toThrow();
});

test.skipIf(process.platform !== "darwin")(
  "Finder binary property list uses all selected files before preview and text",
  async () => {
    const files = ["/tmp/한 글.png", "/tmp/a'b.png"];
    const plist = execFileSync(
      "/usr/bin/plutil",
      ["-convert", "binary1", "-o", "-", "--", "-"],
      { input: JSON.stringify(files) },
    );
    const result = await prepareTerminalClipboard(
      options([
        item({
          [osClipboardFormat("NSFilenamesPboardType")]: plist,
          [osClipboardFormat("public.file-url")]: "file:///tmp/wrong.png",
          "image/png": png,
          "text/plain": "wrong",
        }),
      ]),
    );
    expect(result).toEqual({
      kind: "files",
      paths: files,
      text: quotePastePaths(files, "zsh"),
    });
  },
);

test("file URL lists precede images; browser links stay text; SSH rejects files but accepts literal text", async () => {
  const fileItem = item({
    "text/uri-list": "file:///tmp/a.png\nfile:///tmp/b.png",
    "image/png": png,
    "text/plain": "wrong",
  });
  expect(await prepareTerminalClipboard(options([fileItem]))).toMatchObject({
    kind: "files",
    paths: ["/tmp/a.png", "/tmp/b.png"],
  });
  await expect(
    prepareTerminalClipboard({ ...options([fileItem]), shell: undefined }),
  ).rejects.toThrow("SSH");
  expect(
    await prepareTerminalClipboard({
      ...options([item({ "text/plain": "{{literal}}\n" })]),
      shell: undefined,
    }),
  ).toEqual({ kind: "text", text: "{{literal}}\n" });
  expect(
    await prepareTerminalClipboard(
      options([
        item({
          "text/uri-list": "https://example.com/",
          "text/plain": "https://example.com/",
        }),
      ]),
    ),
  ).toEqual({ kind: "text", text: "https://example.com/" });
  expect(await prepareTerminalClipboard(options([]))).toEqual({
    kind: "empty",
  });
});

test("image paths are returned only after durable unique saves; errors and remote sessions never paste a path", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "passport-paste-"));
  try {
    const config = {
      ...options([item({ "image/png": png, "text/plain": "wrong" })]),
      userData: directory,
    };
    const a = await prepareTerminalClipboard(config),
      b = await prepareTerminalClipboard(config);
    expect(a.kind).toBe("image");
    expect(b.kind).toBe("image");
    if (a.kind !== "image" || b.kind !== "image")
      throw new Error("image expected");
    expect(a.path).not.toBe(b.path);
    expect(await fs.readFile(a.path)).toEqual(png);
    expect(a.text).toBe(quotePastePaths([a.path], "zsh"));
    await expect(
      prepareTerminalClipboard({ ...config, shell: undefined }),
    ).rejects.toThrow("SSH");
    await expect(
      prepareTerminalClipboard({ ...config, toPNG: () => Buffer.alloc(0) }),
    ).rejects.toThrow("PNG");
    await expect(
      prepareTerminalClipboard({ ...config, userData: a.path }),
    ).rejects.toThrow();
    let checks = 0;
    await expect(
      prepareTerminalClipboard({
        ...config,
        check: () => {
          if (++checks > 1) throw new Error("closed");
        },
      }),
    ).rejects.toThrow("closed");
    expect(await fs.readdir(path.join(directory, "paste-images"))).toHaveLength(
      2,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("paste queue preserves gesture order and cancels a closed or reconnected target", async () => {
  const queue = new PasteQueue();
  const delivered: string[] = [],
    errors: unknown[] = [];
  let finish!: (text: string) => void;
  let valid = true;
  const first = queue.enqueue(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    () => valid,
    (text) => delivered.push(text),
    (error) => errors.push(error),
  );
  const second = queue.enqueue(
    async () => "second",
    () => valid,
    (text) => delivered.push(text),
    (error) => errors.push(error),
  );
  await Promise.resolve();
  finish("first");
  await Promise.all([first, second]);
  expect(delivered).toEqual(["first", "second"]);
  const closed = queue.enqueue(
    async () => "stale",
    () => valid,
    (text) => delivered.push(text),
    (error) => errors.push(error),
  );
  valid = false;
  await closed;
  expect(delivered).toHaveLength(2);
  valid = true;
  await queue.enqueue(
    async () => {
      throw new Error("read failed");
    },
    () => valid,
    () => {},
    (error) => errors.push(error),
  );
  await queue.enqueue(
    async () => "recovered",
    () => valid,
    (text) => delivered.push(text),
    (error) => errors.push(error),
  );
  expect(errors).toHaveLength(1);
  expect(delivered.at(-1)).toBe("recovered");
});
