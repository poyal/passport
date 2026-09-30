import { describe, it, expect } from "vitest";
import { randomUUID as id } from "node:crypto";
import {
  cloneWorkspaces,
  templatesWithoutHost,
} from "../src/shared/workspace-templates";
import { panes } from "../src/shared/layout";
import {
  documentSchema,
  emptyDocument,
  hostSchema,
  type Workspace,
} from "../src/shared/model";
import {
  encodePortable,
  decodePortable,
  mergePortable,
} from "../src/main/portable";

const host = () =>
  hostSchema.parse({
    id: id(),
    name: "fixture",
    address: "localhost",
    username: "tester",
  });
function fixture() {
  const h = host(),
    a = id(),
    b = id();
  const workspaces: Workspace[] = [
    {
      id: id(),
      name: "Nested layout",
      root: {
        kind: "split",
        id: id(),
        direction: "horizontal",
        ratio: 0.31,
        children: [
          { kind: "pane", id: a, hostId: h.id, startPath: "/tmp" },
          { kind: "pane", id: b, hostId: h.id },
        ],
      },
    },
  ];
  const template = {
    id: id(),
    name: "Saved",
    ...cloneWorkspaces(workspaces, workspaces[0].id, b, id),
  };
  return {
    h,
    workspaces,
    template,
    document: {
      ...emptyDocument(),
      hosts: [h],
      workspaces,
      workspaceTemplates: [template],
    },
  };
}
describe("saved workspaces", () => {
  it("copies split ratios, order and focus while using independent IDs every time", () => {
    const { workspaces, template, document } = fixture();
    const reopened = cloneWorkspaces(
      template.workspaces,
      template.activeWorkspaceId,
      template.activePaneId,
      id,
    );
    const reopenedAgain = cloneWorkspaces(
      template.workspaces,
      template.activeWorkspaceId,
      template.activePaneId,
      id,
    );
    expect(reopened.workspaces[0].root).toMatchObject({
      direction: "horizontal",
      ratio: 0.31,
    });
    expect(reopened.activePaneId).toBe(
      panes(reopened.workspaces[0].root)[1].id,
    );
    const ids = [
      workspaces,
      template.workspaces,
      reopened.workspaces,
      reopenedAgain.workspaces,
    ].flatMap((ws) => ws.flatMap((w) => panes(w.root).map((p) => p.id)));
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      documentSchema.parse({
        ...document,
        workspaces: [
          ...workspaces,
          ...reopened.workspaces,
          ...reopenedAgain.workspaces,
        ],
      }).workspaces,
    ).toHaveLength(3);
    reopened.workspaces[0].name = "Changed";
    expect(template.workspaces[0].name).toBe("Nested layout");
  });
  it("reads older documents and independently validates saved host references, focus and limits", () => {
    const { document } = fixture();
    const { workspaceTemplates, ...old } = document;
    expect(documentSchema.parse(old).workspaceTemplates).toEqual([]);
    expect(documentSchema.safeParse({ ...document, hosts: [] }).success).toBe(
      false,
    );
    expect(
      documentSchema.safeParse({
        ...document,
        workspaceTemplates: [{ ...workspaceTemplates[0], activePaneId: id() }],
      }).success,
    ).toBe(false);
    expect(
      documentSchema.safeParse({
        ...document,
        workspaceTemplates: Array.from({ length: 101 }, () => ({
          ...workspaceTemplates[0],
          id: id(),
        })),
      }).success,
    ).toBe(false);
    const tooMany = Array.from(
      { length: 32 },
      () =>
        cloneWorkspaces(document.workspaces, document.workspaces[0].id, "", id)
          .workspaces[0],
    );
    expect(
      documentSchema.safeParse({
        ...document,
        workspaceTemplates: [{ ...workspaceTemplates[0], workspaces: tooMany }],
      }).success,
    ).toBe(false);
  });
  it("removes deleted hosts, collapses branches and repairs saved focus without deleting surviving local panes", () => {
    const { h, template } = fixture();
    const local = panes(template.workspaces[0].root)[0];
    local.local = { shell: "default", cwd: "" };
    const [next] = templatesWithoutHost([template], h.id);
    expect(panes(next.workspaces[0].root)).toEqual([local]);
    expect(next.activePaneId).toBe(local.id);
    delete local.local;
    expect(templatesWithoutHost([template], h.id)).toEqual([]);
  });
  it("exports and imports templates with remapped host IDs and preserved focus and ratios", async () => {
    const { document, template } = fixture();
    const data = {
      format: "passport" as const,
      version: 1 as const,
      document,
      profiles: [],
    };
    const roundtrip = await decodePortable(await encodePortable(data));
    expect(roundtrip.document.workspaceTemplates).toEqual([template]);
    const currentHost = host();
    const current = { ...emptyDocument(), hosts: [currentHost] };
    const merged = mergePortable(current, [], roundtrip, "overwrite").document;
    expect(merged.hosts).toHaveLength(1);
    expect(
      panes(merged.workspaceTemplates[0].workspaces[0].root).every(
        (p) => p.hostId === currentHost.id,
      ),
    ).toBe(true);
    expect(merged.workspaceTemplates[0].activePaneId).toBe(
      panes(merged.workspaceTemplates[0].workspaces[0].root)[1].id,
    );
    expect(merged.workspaceTemplates[0].workspaces[0].root).toMatchObject({
      ratio: 0.31,
    });
    const skipped = mergePortable(merged, [], roundtrip, "skip").document;
    expect(skipped.workspaceTemplates).toEqual(merged.workspaceTemplates);
  });
});
