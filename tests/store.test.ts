import { it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, type Vault } from "../src/main/store";
import { hostSchema } from "../src/shared/model";
import Database from "better-sqlite3";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const vault: Vault = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s.split("").reverse().join("")),
  decryptString: (b) => b.toString().split("").reverse().join(""),
};
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
    expect(store.db.pragma("user_version", { simple: true })).toBe(2);
    expect(store.read().hosts[0].name).toBe("기존 서버");
    expect(store.read().tunnels).toEqual([]);
    expect(store.read().settings.shortcuts.newTab).toBe("Mod+Shift+T");
    store.close();
    const future = new Database(path.join(dir, "passport.sqlite"));
    future.pragma("user_version=3");
    future.close();
    expect(() => new Store(dir, vault)).toThrow("새로운 Passport");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
