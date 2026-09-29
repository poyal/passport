import { describe, it, expect } from "vitest";
import { randomUUID as id } from "node:crypto";
import {
  insertSplit,
  moveLayout,
  panes,
  preparePaste,
  removeNode,
} from "../src/shared/layout";
import {
  emptyDocument,
  documentSchema,
  hostSchema,
  type Pane,
} from "../src/shared/model";
const pane = (): Pane => ({ kind: "pane", id: id(), hostId: id() });
describe("workspace layout", () => {
  it("moves an entire split tab without changing pane/session IDs", () => {
    const a = pane(),
      b = pane(),
      c = pane();
    const one = { id: id(), name: "A", root: a };
    const two = {
      id: id(),
      name: "B",
      root: insertSplit(b, b.id, c, "bottom", id()),
    };
    const next = moveLayout(
      [one, two],
      two.id,
      two.root.id,
      one.id,
      a.id,
      "right",
      id(),
    );
    expect(next).toHaveLength(1);
    expect(panes(next[0].root).map((p) => p.id)).toEqual([a.id, b.id, c.id]);
    expect(
      removeNode(next[0].root, b.id) && panes(removeNode(next[0].root, b.id)!),
    ).toHaveLength(2);
  });
  it("ignores dropping a tree inside itself", () => {
    const p = pane();
    const w = { id: id(), name: "A", root: p };
    expect(moveLayout([w], w.id, p.id, w.id, p.id, "right", id())).toEqual([w]);
  });
  it("moves a pane within a workspace and collapses empty branches", () => {
    const a = pane(),
      b = pane(),
      c = pane();
    const root = insertSplit(
      insertSplit(a, a.id, b, "right", id()),
      a.id,
      c,
      "bottom",
      id(),
    );
    const w = { id: id(), name: "A", root };
    const moved = moveLayout([w], w.id, c.id, w.id, b.id, "right", id());
    expect(panes(moved[0].root).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect(new Set(panes(moved[0].root).map((x) => x.id)).size).toBe(3);
  });
  it("rejects more than 16 panes", () => {
    let root = pane() as ReturnType<typeof insertSplit>;
    for (let i = 0; i < 15; i++)
      root = insertSplit(root, panes(root)[0].id, pane(), "right", id());
    expect(() =>
      insertSplit(root, panes(root)[0].id, pane(), "right", id()),
    ).toThrow("16");
  });
});
describe("safe paste", () => {
  it("strips trailing command execution newlines", () =>
    expect(preparePaste("echo hello\r\n", false)).toBe("echo hello"));
  it("rejects multiline on a shell without bracketed paste", () =>
    expect(() => preparePaste("pwd\nls", false)).toThrow());
  it("keeps multiline in bracketed mode but rejects terminal escapes", () => {
    expect(preparePaste("pwd\nls", true)).toBe("pwd\nls");
    expect(() => preparePaste("a\x1b[201~\nwhoami", true)).toThrow();
  });
});
describe("document validation", () => {
  it("rejects cyclic group references", () => {
    const a = id(),
      b = id();
    expect(
      documentSchema.safeParse({
        ...emptyDocument(),
        groups: [
          { id: a, name: "a", parentId: b },
          { id: b, name: "b", parentId: a },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects dangling layout host references", () => {
    expect(
      documentSchema.safeParse({
        ...emptyDocument(),
        workspaces: [{ id: id(), name: "A", root: pane() }],
      }).success,
    ).toBe(false);
  });
  it("retains explicit host overrides while leaving inheritance empty", () => {
    const h = hostSchema.parse({
      id: id(),
      name: "A",
      address: "localhost",
      username: "u",
    });
    expect(h.appearance).toEqual({});
  });
});
