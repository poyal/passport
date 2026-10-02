// Opt-in presentation for isolated automation profiles. Normal app launches
// retain their native focus/activation behavior.
export type TestWindowMode = "hidden" | "passive" | undefined;

export function testWindowMode(env: NodeJS.ProcessEnv): TestWindowMode {
  const mode = env.PASSPORT_E2E_WINDOW_MODE;
  if (!mode) return undefined;
  if (mode !== "hidden" && mode !== "passive")
    throw new Error(`Unknown E2E window mode: ${mode}`);
  if (!env.PASSPORT_DATA_DIR)
    throw new Error("E2E window modes require an isolated PASSPORT_DATA_DIR");
  return mode;
}

export function testWindowOptions(mode: TestWindowMode) {
  return mode ? { show: false, focusable: false, skipTaskbar: true } : {};
}

interface WindowPresentation {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  showInactive(): void;
  focus(): void;
}

export function presentWindow(win: WindowPresentation, mode: TestWindowMode) {
  if (mode === "hidden") return;
  if (mode === "passive") {
    win.showInactive();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
