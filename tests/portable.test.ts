import { describe, it, expect } from "vitest";
import { randomUUID as id } from "node:crypto";
import {
  encodePortable,
  decodePortable,
  mergePortable,
  parseSSHConfig,
  safeJson,
  type Portable,
} from "../src/main/portable";
import { emptyDocument, hostSchema } from "../src/shared/model";
function sample(): Portable {
  const auth = id();
  return {
    format: "passport",
    version: 2,
    document: {
      ...emptyDocument(),
      hosts: [
        hostSchema.parse({
          id: id(),
          name: "A",
          address: "localhost",
          username: "user",
          authId: auth,
        }),
      ],
    },
    profiles: [{ id: auth, name: "secret", type: "password" }],
    secrets: {
      [auth]: {
        type: "password",
        password: "hidden password",
        privateKey: "",
        passphrase: "",
      },
    },
  };
}
describe("portable files", () => {
  it("excludes all secret material by default", async () => {
    const text = await encodePortable(sample());
    expect(text).not.toContain("hidden password");
    expect((await decodePortable(text)).secrets).toBeUndefined();
  });
  it("round trips secrets with a separate authenticated encryption key", async () => {
    const data = sample();
    const text = await encodePortable(data, "long test password");
    expect(text).not.toContain("hidden password");
    expect(await decodePortable(text, "long test password")).toEqual(data);
    await expect(decodePortable(text, "wrong password")).rejects.toThrow(
      "손상",
    );
    const bad = JSON.parse(text);
    bad.tag = "0".repeat(32);
    await expect(
      decodePortable(JSON.stringify(bad), "long test password"),
    ).rejects.toThrow();
  });
  it("deduplicates hosts by endpoint and remaps imported layout references", () => {
    const a = sample(),
      b = sample();
    const old = a.document.hosts[0];
    b.document.hosts[0].name = "new";
    b.document.workspaces = [
      {
        id: id(),
        name: "W",
        root: { kind: "pane", id: id(), hostId: b.document.hosts[0].id },
      },
    ];
    const merged = mergePortable(a.document, a.profiles, b, "overwrite");
    expect(merged.document.hosts).toHaveLength(1);
    expect(merged.document.hosts[0].id).toBe(old.id);
    expect(merged.document.hosts[0].name).toBe("new");
    expect(merged.document.workspaces[0].root).toMatchObject({
      hostId: old.id,
    });
  });
  it("does not replace existing secrets in skip mode", () => {
    const a = sample(),
      b = structuredClone(a);
    b.secrets![b.profiles[0].id].password = "changed";
    expect(mergePortable(a.document, a.profiles, b, "skip").secrets).toEqual(
      {},
    );
  });
  it("rejects deeply nested untrusted files before schema recursion", () =>
    expect(() => safeJson("[".repeat(100) + "0" + "]".repeat(100))).toThrow(
      "중첩",
    ));
});
describe("SSH config import", () => {
  it("imports supported fields and reports unsupported execution/proxy directives", () => {
    const result = parseSSHConfig(
      "Host build\n HostName 127.0.0.1\n User builder\n Port 2222\n ProxyCommand arbitrary command\n IdentityFile ~/.ssh/id_ed25519\nHost *.internal\n User root",
    );
    expect(result.document.hosts).toHaveLength(1);
    expect(result.document.hosts[0]).toMatchObject({
      name: "build",
      address: "127.0.0.1",
      port: 2222,
      username: "builder",
    });
    expect(result.warnings.some((w) => w.includes("ProxyCommand"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("IdentityFile"))).toBe(true);
  });
});
