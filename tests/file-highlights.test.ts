import { describe, expect, test } from "vitest";
import { findFileHighlight, findHighlights } from "../src/shared/highlights";
import { appearanceSchema } from "../src/shared/model";

describe("file type highlights from long listings", () => {
  test.each([
    ["drwxr-xr-x. 2 root root 4096 7월 19 11:16 문서", "directory", "문서"],
    [
      "-rwxr-xr-x 1 root root 816 Sep 30 2026 hardware id.sh",
      "executable",
      "hardware id.sh",
    ],
    [
      "lrwxrwxrwx+ 1 root root 6 Sep 30 13:10 current link -> releases",
      "symlink",
      "current link",
    ],
    [
      "drwxr-xr-x@ 2 user staff 64 2026-09-30 13:10:23.000 +0900 logs",
      "directory",
      "logs",
    ],
    ["-rwsr--r-- 1 root root 816 Sep 30 13:10 setuid", "executable", "setuid"],
    ["-rw-r--r-t 1 root root 816 Sep 30 13:10 sticky", "executable", "sticky"],
  ])("classifies %s without coloring metadata", (text, kind, name) => {
    const token = findFileHighlight(text)!;
    expect(token.kind).toBe(kind);
    expect(text.slice(token.start, token.end)).toBe(name);
    expect(findHighlights(text, "none", false, true)).toEqual([token]);
  });
  test.each([
    "-rw-r--r-- 1 root root 816 Sep 30 13:10 run.sh",
    "-rwSr--r-T 1 root root 816 Sep 30 13:10 disabled",
    "crwxrwxrwx 1 root root 816 Sep 30 13:10 device",
    "ERROR logs hardware_id.sh",
    "drwxr-xr-x logs",
  ])("does not guess from names or extensions: %s", (text) => {
    expect(findFileHighlight(text)).toBeUndefined();
  });
  test("file names take precedence over log and address decorations", () => {
    const text = "drwxr-xr-x 2 root root 4096 Sep 30 13:10 INFO 192.0.2.10";
    expect(findHighlights(text, "log", true, true)).toEqual([
      findFileHighlight(text),
    ]);
    expect(findHighlights(text, "none")).toEqual([]);
  });
  test("old settings enable file colors without changing other choices", () => {
    const appearance = appearanceSchema.parse({
      theme: "nord",
      highlight: "none",
    });
    expect(appearance.highlightFiles).toBe(true);
    expect(appearance.theme).toBe("nord");
    expect(
      appearanceSchema.parse({ highlightFiles: false }).highlightFiles,
    ).toBe(false);
  });
});
