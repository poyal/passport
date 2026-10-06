import { it, expect } from "vitest";
import { randomUUID as id } from "node:crypto";
import {
  emptyDocument,
  hostSchema,
  groupSchema,
  documentSchema,
  tunnelSchema,
} from "../src/shared/model";
import {
  effectiveHost,
  interpolate,
  variables,
  executableCommand,
  shortcutMatch,
  validateShortcuts,
  LOCAL_HOST_ID,
} from "../src/shared/advanced";
import { findHighlights } from "../src/shared/highlights";
import {
  encodePortable,
  decodePortable,
  mergePortable,
} from "../src/main/portable";

it("inherits nested group defaults only for opted-in fields, with host appearance taking precedence", () => {
  const doc = emptyDocument(),
    auth = id();
  const parent = groupSchema.parse({
    id: id(),
    name: "상위",
    parentId: null,
    defaults: {
      port: 2222,
      username: "parent",
      authId: auth,
      appearance: { theme: "nord", fontSize: 16 },
    },
  });
  const child = groupSchema.parse({
    id: id(),
    name: "하위",
    parentId: parent.id,
    defaults: { username: "child", appearance: { fontSize: 18 } },
  });
  doc.groups = [parent, child];
  const host = hostSchema.parse({
    id: id(),
    name: "server",
    address: "localhost",
    username: "own",
    groupId: child.id,
    inherit: ["port", "authId"],
    appearance: { fontSize: 20 },
  });
  expect(effectiveHost(doc, host)).toMatchObject({
    port: 2222,
    username: "own",
    authId: auth,
    appearance: { theme: "nord", fontSize: 20 },
  });
  expect(effectiveHost(doc, { ...host, inherit: ["username"] })).toMatchObject({
    port: 22,
    username: "child",
    authId: null,
  });
});
it("substitutes command variables literally, requires all values, and rejects control codes", () => {
  expect(variables("echo {{ name }} {{name}} {{path}}")).toEqual([
    "name",
    "path",
  ]);
  expect(interpolate("echo {{name}}", { name: "$& `whoami` {{other}}" })).toBe(
    "echo $& `whoami` {{other}}",
  );
  expect(() => interpolate("{{missing}}", {})).toThrow("missing");
  expect(executableCommand("printf x\r\n")).toBe("printf x");
  expect(() => executableCommand("\x1b[5n")).toThrow();
});
it("validates both operating system shortcut maps and explicit terminal controls", () => {
  const keys = emptyDocument().settings.shortcuts;
  expect(() => validateShortcuts(keys)).not.toThrow();
  expect(() =>
    validateShortcuts({
      ...keys,
      win32: { ...keys.win32, newTab: keys.win32.search },
    }),
  ).toThrow("중복");
  expect(
    shortcutMatch(
      {
        key: "C",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
      },
      "Platform+C",
      false,
    ),
  ).toBe(true);
  expect(
    shortcutMatch(
      {
        key: "c",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      "Platform+C",
      false,
    ),
  ).toBe(false);
});
it("finds bounded log levels and valid addresses without modifying source text", () => {
  const text =
    "[ERROR] 한국어 127.0.0.1:22 999.0.0.1 ERROR_FILE https://example.com/path [::1]:22";
  const tokens = findHighlights(text, "log", true).map((t) =>
    text.slice(t.start, t.end),
  );
  expect(tokens).toContain("ERROR");
  expect(tokens).toContain("127.0.0.1:22");
  expect(tokens).toContain("[::1]:22");
  expect(tokens).toContain("https://example.com/path");
  expect(tokens).not.toContain("999.0.0.1");
  expect(tokens.filter((t) => t === "ERROR")).toHaveLength(1);
  expect(findHighlights(text, "none")).toEqual([]);
});
it("keeps local terminals and remaps tunnel hosts in portable imports", async () => {
  const doc = emptyDocument();
  const host = hostSchema.parse({
    id: id(),
    name: "old",
    address: "localhost",
    username: "user",
  });
  doc.hosts = [host];
  const incoming = emptyDocument();
  incoming.hosts = [{ ...host, id: id(), name: "new" }];
  incoming.workspaces = [
    {
      id: id(),
      name: "로컬",
      root: {
        kind: "pane",
        id: id(),
        hostId: LOCAL_HOST_ID,
        local: { shell: "default", cwd: "" },
      },
    },
  ];
  incoming.tunnels = [
    tunnelSchema.parse({
      id: id(),
      name: "test",
      hostId: incoming.hosts[0].id,
      kind: "local",
      bindPort: 8080,
    }),
  ];
  const portable = await decodePortable(
    await encodePortable({
      format: "passport",
      version: 2,
      document: incoming,
      profiles: [],
    }),
  );
  const merged = mergePortable(doc, [], portable, "overwrite");
  expect(merged.document.tunnels[0].hostId).toBe(host.id);
  expect(
    documentSchema.parse(merged.document).workspaces[0].root,
  ).toMatchObject({ local: { shell: "default" } });
});
