import { it, expect } from "vitest";
import { localTerminalEnv } from "../src/main/terminal-env";

it("separates interactive PTY color capabilities from the desktop launch environment", () => {
  const parent = {
    PATH: "/fixture/bin",
    CUSTOM_PROJECT: "keep",
    TERM: "dumb",
    term_program: "other-terminal",
    COLORTERM: "",
    NO_COLOR: "1",
    force_color: "0",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "1",
    TERM_SESSION_ID: "parent-session",
  };
  const before = { ...parent };
  expect(localTerminalEnv(parent)).toEqual({
    PATH: "/fixture/bin",
    CUSTOM_PROJECT: "keep",
    TERM: "xterm-256color",
    TERM_PROGRAM: "Passport",
    COLORTERM: "truecolor",
  });
  expect(parent).toEqual(before);
});
