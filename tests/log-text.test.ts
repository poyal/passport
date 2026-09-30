import { it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LogTextDecoder } from "../src/main/log-text";
import { SessionLogs } from "../src/main/logs";
import { Store } from "../src/main/store";

it("filters split terminal controls while retaining Korean, emoji, tabs, and line endings", () => {
  const source =
    "\x1b[?2026h\x1b[31m한글😀\x1b[0m\r\n" +
    "\x1b]8;;https://example.test\x1b\\링크\x1b]8;;\x07\t파일\r" +
    "\x1bPdiscarded\x1b\\\x1b(BA\x9b2JB\x9dtitle\x9cC\x1b[?2026l\x07";
  for (let split = 0; split <= source.length; split++) {
    // Split only on Unicode code point boundaries, as StringDecoder does.
    if (split && /[\uD800-\uDBFF]/.test(source[split - 1])) continue;
    const decoder = new LogTextDecoder(0, true);
    const first = decoder.write(source.slice(0, split), 0);
    const second = decoder.write(
      source.slice(split),
      Buffer.byteLength(source.slice(0, split)),
    );
    expect(first.text + second.text).toBe("한글😀\n링크\t파일\nABC");
    const offsets = first.offsets.concat(second.offsets);
    expect(offsets).toHaveLength((first.text + second.text).length);
    expect(offsets[0]).toBe(
      Buffer.byteLength(source.slice(0, source.indexOf("한"))),
    );
  }
});

it("reads and searches clean logs across UTF-8 and ANSI boundaries with raw byte bookmarks and lossless export", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-log-text-"),
  );
  const store = new Store(directory, {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw Error("unused");
    },
    decryptString: () => {
      throw Error("unused");
    },
  });
  try {
    const logs = new SessionLogs(store);
    const text =
      "x".repeat(262142) +
      "한글\x1b[31m검색\x1b[0m\r\n\x1b]8;;https://example.test\x1b\\링크\x1b]8;;\x1b\\ 끝\r\n";
    logs.start("fixture", "clean log");
    logs.append("fixture", text);
    logs.stop("fixture");
    const id = logs.list()[0].id;
    const first = logs.read(id, 0, "", true);
    const second = logs.read(id, first.next, "", true);
    expect(first.text + second.text).toBe(
      "x".repeat(262142) + "한글검색\n링크 끝\n",
    );
    expect(second.next).toBe(Buffer.byteLength(text));
    const found = logs.read(id, 0, "한글검색", true);
    expect(found.matches).toEqual([262142]);
    expect(found.text).toContain("한글검색");
    expect(found.text).not.toMatch(/[\x1b\ufffd]/);
    const at = Buffer.byteLength(text.slice(0, text.indexOf("\x1b[31m"))) + 2;
    logs.bookmark(id, at, "inside a control sequence");
    expect(logs.read(id, at, "", true).text).toBe("검색\n링크 끝\n");
    expect(logs.read(id, 0, "missing", true).next).toBe(
      Buffer.byteLength(text),
    );
    expect(logs.read(id, 0).text).toContain("x");
    const destination = path.join(directory, "original.log");
    logs.export(id, destination);
    expect(await fs.readFile(destination, "utf8")).toBe(text);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
