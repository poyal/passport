// Each PTY is a new interactive terminal, independent of the process that
// launched the desktop app (which may be a colorless build/test runner).
// Shell startup files and Passport profiles run afterwards and can still
// explicitly opt out of color or override these capability defaults.
export function localTerminalEnv(
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...parent };
  const reset = new Set([
    "TERM",
    "TERM_PROGRAM",
    "COLORTERM",
    "TERM_SESSION_ID",
    "NO_COLOR",
    "FORCE_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "PASSPORT_CONTROL_ENDPOINT",
    "PASSPORT_CONTROL_TOKEN",
    "PASSPORT_PANE_ID",
    "PASSPORT_SESSION_ID",
    "PASSPORT_ENDPOINT",
    "PASSPORT_TOKEN",
    "PASSPORT_GENERATION",
    "PASSPORT_AGENT_RUN",
    "PASSPORT_RESUME",
    "PASSPORT_AGENT_RESUME",
    "PASSPORT_CLAUDE",
    "PASSPORT_CODEX",
    "PASSPORT_CLAUDE_SETTINGS",
    "PASSPORT_STARTUP",
    "PASSPORT_INIT_FAILED",
    "PASSPORT_USER_ZDOTDIR",
    "PASSPORT_HAD_ZDOTDIR",
  ]);
  // A desktop app launched from a Passport pane must not reuse that pane's
  // credentials, AI run identity or loader state. prepareLaunch supplies its own.
  for (const name of Object.keys(env))
    if (reset.has(name.toUpperCase())) delete env[name];
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "Passport",
  };
}
