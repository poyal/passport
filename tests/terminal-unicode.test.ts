import { afterEach, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { configureTerminalUnicode } from "../src/renderer/terminal-unicode";
import fixture from "./fixtures/terminal-unicode-zsh.json";

const terminals: Terminal[] = [];
afterEach(() => terminals.splice(0).forEach((term) => term.dispose()));

function createTerminal() {
  const term = new Terminal({
    cols: fixture.cols,
    rows: fixture.rows,
    allowProposedApi: true,
  });
  configureTerminalUnicode(term);
  terminals.push(term);
  return term;
}
const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));
const screen = (term: Terminal) => {
  const buffer = term.buffer.active;
  return Array.from({ length: buffer.length }, (_, y) =>
    buffer.getLine(y)!.translateToString(true),
  )
    .join("")
    .trimEnd();
};

for (const sample of fixture.cases) {
  it(`edits wrapped zsh input without stale characters after ${sample.prompt}`, async () => {
    const term = createTerminal();
    for (const step of sample.steps) await write(term, step.output);
    expect(screen(term)).toBe(sample.expected);
    expect(term.buffer.active.cursorX).toBe(sample.cursor.x);
    expect(term.buffer.active.cursorY).toBe(sample.cursor.y);
  });

  it(`preserves ${sample.prompt} cell positions through snapshot restore and reset`, async () => {
    const original = createTerminal();
    const serialize = new SerializeAddon();
    original.loadAddon(serialize);
    for (const step of sample.steps) await write(original, step.output);
    const restored = createTerminal();
    restored.reset();
    await write(restored, serialize.serialize());
    expect(screen(restored)).toBe(sample.expected);
    expect(restored.buffer.active.cursorX).toBe(sample.cursor.x);
    expect(restored.buffer.active.cursorY).toBe(sample.cursor.y);
    await write(restored, "\bZ");
    expect(screen(restored)).toBe(sample.expected.slice(0, -1) + "Z");
  });
}

it("keeps emoji, CJK and combining accents aligned when output is chunked", async () => {
  const term = createTerminal();
  for (const part of ["A", "💻", "🔧", "🚀", "한中", "e", "\u0301", "Z"])
    await write(term, part);
  expect(screen(term)).toBe("A💻🔧🚀한中éZ");
  expect(term.buffer.active.cursorX).toBe(13);
  expect(term.buffer.active.getLine(0)!.getCell(1)!.getWidth()).toBe(2);
  expect(term.buffer.active.getLine(0)!.getCell(2)!.getWidth()).toBe(0);
});
