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

it("isolates new terminals from the parent Passport session and loader", () => {
  const parent = {
    PATH: "/fixture/bin",
    ZDOTDIR: "/fixture/user-startup",
    CUSTOM_PROJECT: "keep",
    PASSPORT_CONTROL_ENDPOINT: "/fixture/control",
    PASSPORT_CONTROL_TOKEN: "parent-control-token",
    PASSPORT_PANE_ID: "parent-pane",
    PASSPORT_SESSION_ID: "parent-session",
    PASSPORT_ENDPOINT: "/fixture/activity",
    PASSPORT_TOKEN: "parent-activity-token",
    PASSPORT_GENERATION: "parent-generation",
    PASSPORT_AGENT_RUN: "parent-run",
    PASSPORT_RESUME: "1",
    PASSPORT_AGENT_RESUME: "/fixture/resume.json",
    PASSPORT_CLAUDE: "1",
    PASSPORT_CODEX: "1",
    PASSPORT_CLAUDE_SETTINGS: "/fixture/claude-settings.json",
    PASSPORT_STARTUP: "/fixture/startup.cmd",
    PASSPORT_INIT_FAILED: "1",
    PASSPORT_USER_ZDOTDIR: "/fixture/parent-startup",
    PASSPORT_HAD_ZDOTDIR: "0",
    passport_resume: "1",
    Passport_Token: "case-insensitive-parent-token",
  };
  const before = { ...parent };
  expect(localTerminalEnv(parent)).toEqual({
    PATH: parent.PATH,
    ZDOTDIR: parent.ZDOTDIR,
    CUSTOM_PROJECT: "keep",
    TERM: "xterm-256color",
    TERM_PROGRAM: "Passport",
    COLORTERM: "truecolor",
  });
  expect(parent).toEqual(before);
});
