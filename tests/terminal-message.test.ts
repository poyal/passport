import { expect, it } from "vitest";
import {
  terminalMessageCodeBlock,
  validateMarkdown,
} from "../src/shared/share";

it("wraps terminal text without closing on embedded Markdown or losing Unicode and blank lines", () => {
  const text = "  한글 👋\r\n```sh\nx\n```\n\n";
  expect(terminalMessageCodeBlock(text)).toBe("````\n" + text + "````");
  expect(terminalMessageCodeBlock("last line")).toBe("```\nlast line\n```");
  const manyRuns = "` ".repeat(128 * 1024);
  expect(terminalMessageCodeBlock(manyRuns)).toContain(manyRuns);
  expect(() =>
    validateMarkdown(terminalMessageCodeBlock("a".repeat(256 * 1024))),
  ).toThrow(/256 KiB/);
});
