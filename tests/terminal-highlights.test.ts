import { afterEach, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { highlightTerminal } from "../src/renderer/highlights";
import { emptyDocument } from "../src/shared/model";
import { getTheme } from "../src/shared/themes";

afterEach(() => vi.unstubAllGlobals());

it("coalesces a burst of scrolling output into the latest viewport's colors and cancels work on disposal", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  let parsed!: () => void;
  let text = "INFO first";
  const appearance = {
    ...emptyDocument().settings.appearance,
    highlight: "log" as const,
    highlightAddresses: false,
    highlightFiles: false,
  };
  const buffer = {
    type: "normal",
    viewportY: 0,
    baseY: 0,
    cursorY: 0,
    length: 1000,
    getLine: () => ({
      length: text.length,
      translateToString: () => text,
      getCell: (x: number) => ({
        getChars: () => text[x],
        getWidth: () => 1,
        isFgDefault: () => true,
        isBgDefault: () => true,
      }),
    }),
  };
  const decorations: { options: any; dispose: ReturnType<typeof vi.fn> }[] = [];
  const registerMarker = vi.fn((offset: number) => ({
    line: buffer.baseY + offset,
    isDisposed: false,
    dispose() {
      this.isDisposed = true;
    },
  }));
  const term = {
    rows: 1,
    buffer: { active: buffer },
    registerMarker,
    registerDecoration: (options: unknown) => {
      const decoration = { options, dispose: vi.fn() };
      decorations.push(decoration);
      return decoration;
    },
    onWriteParsed: (callback: () => void) => {
      parsed = callback;
      return { dispose() {} };
    },
    onScroll: () => ({ dispose() {} }),
    onResize: () => ({ dispose() {} }),
  };
  const highlights = highlightTerminal(
    term as unknown as Terminal,
    () => appearance,
    () => [],
  );
  for (let i = 0; i < 100; i++) {
    buffer.viewportY = buffer.baseY = i;
    text = i === 99 ? "ERROR latest" : "INFO first";
    parsed();
  }
  expect(registerMarker).not.toHaveBeenCalled();
  expect(frames.size).toBe(1);
  const callback = [...frames.values()][0];
  frames.clear();
  callback(16);
  expect(registerMarker).toHaveBeenCalledTimes(1);
  expect(decorations).toHaveLength(1);
  expect(decorations[0].options).toMatchObject({
    x: 0,
    width: 5,
    foregroundColor: getTheme(appearance.theme).theme.red,
  });
  parsed();
  highlights.dispose();
  expect(frames.size).toBe(0);
  expect(decorations[0].dispose).toHaveBeenCalledOnce();
});
