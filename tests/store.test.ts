import { it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, type Vault } from "../src/main/store";
import { hostSchema } from "../src/shared/model";
import Database from "better-sqlite3";
import { cloneWorkspaces } from "../src/shared/workspace-templates";
import { LOCAL_HOST_ID } from "../src/shared/advanced";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const vault: Vault = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s.split("").reverse().join("")),
  decryptString: (b) => b.toString().split("").reverse().join(""),
};
it("upgrades v4 atomically, backs up and removes only multi-tab templates permanently", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "passport-template-v4-"));
  let store = new Store(dir, vault);
  try {
    const document = store.read();
    const workspace = {
      id: randomUUID(),
      name: "Local project",
      root: {
        kind: "pane" as const,
        id: randomUUID(),
        hostId: LOCAL_HOST_ID,
        local: { shell: "default" as const, cwd: "" },
      },
    };
    document.workspaces = [workspace];
    const template = {
      id: randomUUID(),
      name: "One tab",
      ...cloneWorkspaces(
        [workspace],
        workspace.id,
        workspace.root.id,
        randomUUID,
      ),
    };
    document.workspaceTemplates = [
      template,
      {
        ...template,
        id: randomUUID(),
        name: "Whole window",
        ...cloneWorkspaces(
          [
            workspace,
            {
              ...workspace,
              id: randomUUID(),
              root: { ...workspace.root, id: randomUUID() },
            },
          ],
          workspace.id,
          "",
          randomUUID,
        ),
      },
    ];
    store.db
      .prepare("UPDATE metadata SET value=?")
      .run(JSON.stringify(document));
    store.db.pragma("user_version=4");
    store.close();
    store = new Store(dir, vault);
    expect(store.read().workspaceTemplates).toEqual([template]);
    expect(store.read().workspaces).toEqual([workspace]);
    expect(store.db.pragma("user_version", { simple: true })).toBe(5);
    const backup = (await fs.readdir(dir)).find((name) =>
      name.startsWith("before-v5-"),
    )!;
    const original = new Database(path.join(dir, backup), { readonly: true });
    try {
      expect(
        JSON.parse(
          (
            original.prepare("SELECT value FROM metadata").get() as {
              value: string;
            }
          ).value,
        ).workspaceTemplates,
      ).toHaveLength(2);
    } finally {
      original.close();
    }
    store.close();
    store = new Store(dir, vault);
    expect(store.read().workspaceTemplates).toEqual([template]);
  } finally {
    if (store.db.open) store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "passport-db-"));
  const store = new Store(dir, vault);
  cleanups.push(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return store;
}
it("persists metadata and separates protected credentials from exports", async () => {
  const store = await setup();
  const authId = randomUUID();
  store.saveSecret(authId, "test", {
    type: "password",
    password: "private",
    privateKey: "",
    passphrase: "",
  });
  const h = hostSchema.parse({
    id: randomUUID(),
    name: "saved",
    address: "localhost",
    username: "u",
    authId,
  });
  store.save({ ...store.read(), hosts: [h] });
  expect(store.read().hosts[0].name).toBe("saved");
  expect(store.profiles()[0].hasSecret).toBe(true);
  expect(store.portable().secrets).toBeUndefined();
  expect(JSON.stringify(store.portable())).not.toContain("private");
  expect(() => store.deleteSecret(authId)).toThrow("사용 중");
  store.backup();
  expect(store.backups()).toHaveLength(1);
  expect(store.readBackup(store.backups()[0]).secrets?.[authId].password).toBe(
    "private",
  );
});
it("does not store secrets without operating system encryption", async () => {
  const store = await setup();
  const old = store.vault.isEncryptionAvailable;
  store.vault.isEncryptionAvailable = () => false;
  try {
    expect(() =>
      store.saveSecret(randomUUID(), "test", {
        type: "password",
        password: "x",
        privateKey: "",
        passphrase: "",
      }),
    ).toThrow("암호화");
    expect(store.profiles()).toHaveLength(0);
  } finally {
    store.vault.isEncryptionAvailable = old;
  }
});
it("makes old generic Linux imports automatic and keeps manually selected icons", async () => {
  const store = await setup();
  const hosts = [
    { icon: "linux", name: "CentOS 5.3" },
    { icon: "linux", iconPinned: true, name: "CentOS 5.3" },
    { icon: "ubuntu", name: "CentOS 5.3" },
  ].map((h) =>
    hostSchema.parse({
      id: randomUUID(),
      address: "localhost",
      username: "tester",
      ...h,
    }),
  );
  store.save({ ...store.read(), hosts });
  expect(store.read().hosts.map((h) => h.icon)).toEqual([
    "auto",
    "linux",
    "ubuntu",
  ]);
  expect(store.read().hosts[1].iconPinned).toBe(true);
});
it("updates imported profile metadata while preserving compatible secrets only", async () => {
  const store = await setup();
  const id = randomUUID();
  store.saveSecret(id, "원래 이름", {
    type: "password",
    password: "keep",
    privateKey: "",
    passphrase: "",
  });
  store.apply(
    store.read(),
    [{ id, name: "가져온 이름", type: "password" }],
    {},
  );
  expect(store.profiles()[0]).toMatchObject({
    name: "가져온 이름",
    hasSecret: true,
  });
  expect(store.getSecret(id)?.password).toBe("keep");
  store.apply(store.read(), [{ id, name: "키 인증", type: "key" }], {});
  expect(store.profiles()[0]).toMatchObject({ type: "key", hasSecret: false });
  expect(store.getSecret(id)).toBeUndefined();
});
it("upgrades v0.1 metadata without losing hosts and rejects a future database version", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "passport-migration-"));
  try {
    let store = new Store(dir, vault);
    const host = hostSchema.parse({
      id: randomUUID(),
      name: "기존 서버",
      address: "localhost",
      username: "user",
      icon: "server",
    });
    store.save({ ...store.read(), hosts: [host] });
    const old = store.read() as any;
    delete old.revision;
    delete old.tunnels;
    delete old.hosts[0].inherit;
    delete old.settings.shortcuts;
    delete old.settings.customThemes;
    store.db
      .prepare("UPDATE metadata SET value=? WHERE id=1")
      .run(JSON.stringify(old));
    store.db.pragma("user_version = 1");
    store.close();
    store = new Store(dir, vault);
    expect(store.db.pragma("user_version", { simple: true })).toBe(5);
    expect(store.read().hosts[0].name).toBe("기존 서버");
    expect(store.read().hosts[0].icon).toBe("auto");
    expect(store.read().tunnels).toEqual([]);
    expect(store.read().settings.shortcuts.darwin.newTab).toEqual(["Meta+N"]);
    expect(store.read().settings.shortcuts.win32.newTab).toEqual(["Ctrl+N"]);
    store.close();
    const future = new Database(path.join(dir, "passport.sqlite"));
    future.pragma("user_version=6");
    future.close();
    expect(() => new Store(dir, vault)).toThrow("새로운 Passport");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("migrates credential-only v2 profiles and preserves account metadata through backup and import", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "passport-profile-v2-"));
  const id = randomUUID();
  const old = new Database(path.join(dir, "passport.sqlite"));
  const secret = {
    type: "password" as const,
    password: "fixture",
    privateKey: "",
    passphrase: "",
  };
  old.exec(
    "CREATE TABLE credentials(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,secret BLOB); PRAGMA user_version=2;",
  );
  old
    .prepare("INSERT INTO credentials VALUES(?,?,?,?)")
    .run(id, "legacy", "password", vault.encryptString(JSON.stringify(secret)));
  old.close();
  const store = new Store(dir, vault);
  try {
    expect(store.profiles()[0]).toMatchObject({
      id,
      username: "",
      hasSecret: true,
    });
    expect(store.getSecret(id)).toEqual(secret);
    store.saveSecret(id, "account profile", secret, "tester");
    store.backup();
    const backup = store.readBackup(store.backups()[0]);
    expect(backup.profiles[0].username).toBe("tester");
    store.apply(backup.document, backup.profiles, backup.secrets!);
    expect(store.profiles()[0].username).toBe("tester");
    expect(() => store.saveSecret(id, "bad", secret, "a\nb")).toThrow(
      "사용자 이름",
    );
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("keeps independent shortcut lanes and explicit removals after closing and reopening the DB", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-shortcuts-db-"),
  );
  let store = new Store(directory, vault);
  try {
    const document = store.read();
    document.settings.shortcuts.win32.copy = [];
    document.settings.shortcuts.win32.paste = ["Alt+P"];
    document.settings.shortcuts.darwin.newTab = ["Meta+Y", "Meta+Shift+Y"];
    const expected = store.save(document).settings.shortcuts;
    store.close();
    store = new Store(directory, vault);
    expect(store.read().settings.shortcuts).toEqual(expected);
  } finally {
    if (store.db.open) store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
