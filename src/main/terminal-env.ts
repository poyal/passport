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
  ]);
  for (const name of Object.keys(env))
    if (reset.has(name.toUpperCase())) delete env[name];
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "Passport",
  };
}
