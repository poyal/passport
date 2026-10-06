import { expect, it } from "vitest";
import { terminalLinkURL } from "../src/main/terminal-links";

it("preserves web destinations including localhost, queries and fragments", () => {
  for (const url of [
    "https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules",
    "http://localhost:3000/callback?code=a%20b&state=123#complete",
    "http://[::1]:8080/",
  ])
    expect(terminalLinkURL(url)).toBe(url);
  expect(terminalLinkURL("HTTPS://EXAMPLE.COM/문서")).toBe(
    "https://example.com/%EB%AC%B8%EC%84%9C",
  );
});

it.each([
  "file:///Applications/Passport.app",
  "javascript:alert(1)",
  "data:text/html,test",
  "mailto:test@example.com",
  "ms-settings:notifications",
  "passport://app/index.html",
  "//example.com/",
  "https:",
  "https://",
  "https://example.com\\@elsewhere.example/",
  "https://user:secret@example.com/",
  "https://trusted.example@elsewhere.example/",
  "https://example.com/\nfile.exe",
  "https://example.com/\u0000",
  " https://example.com/",
])("rejects non-web or ambiguous terminal destination %j", (url) => {
  expect(() => terminalLinkURL(url)).toThrow();
});

it("enforces the OS URL limit after encoding", () => {
  const prefix = "https://example.com/";
  expect(terminalLinkURL(prefix.padEnd(2081, "a"), "win32")).toHaveLength(2081);
  expect(() => terminalLinkURL(prefix.padEnd(2082, "a"), "win32")).toThrow();
  expect(() => terminalLinkURL(prefix + "가".repeat(230), "win32")).toThrow();
  expect(terminalLinkURL(prefix.padEnd(2082, "a"), "darwin")).toHaveLength(
    2082,
  );
  expect(() => terminalLinkURL(prefix.padEnd(8193, "a"), "darwin")).toThrow();
});
