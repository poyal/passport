import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, type Vault } from "../src/main/store";
import { hostSchema, type Secret } from "../src/shared/model";
import { decodePortable, encodePortable } from "../src/main/portable";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function setup() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-data-recovery-"),
  );
  const vault: Vault = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString(),
  };
  const store = new Store(directory, vault);
  cleanups.push(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, vault, directory };
}
const secret: Secret = {
  type: "password",
  password: "test-only-secret",
  privateKey: "",
  passphrase: "",
};
it("an import encryption failure rolls back profiles, secrets, document and revision together", async () => {
  const { store, vault } = await setup();
  const id = randomUUID();
  store.saveSecret(id, "original", secret, "tester");
  const before = store.read();
  vi.spyOn(vault, "encryptString").mockImplementation(() => {
    throw new Error("encryption unavailable");
  });
  expect(() =>
    store.apply(
      before,
      [
        {
          id,
          name: "replacement",
          type: "password",
          username: "changed",
          hasSecret: true,
        },
      ],
      { [id]: { ...secret, password: "replacement" } },
    ),
  ).toThrow("encryption unavailable");
  expect(store.read()).toEqual(before);
  expect(store.profiles()[0]).toMatchObject({
    name: "original",
    username: "tester",
  });
  expect(store.getSecret(id)).toEqual(secret);
  expect(store.db.pragma("quick_check", { simple: true })).toBe("ok");
});
it("invalid imported references roll back newly inserted credential metadata", async () => {
  const { store } = await setup();
  const before = store.read(),
    id = randomUUID();
  const invalid = {
    ...before,
    hosts: [
      hostSchema.parse({
        id: randomUUID(),
        name: "invalid",
        address: "localhost",
        username: "tester",
        authId: randomUUID(),
      }),
    ],
  };
  expect(() =>
    store.apply(
      invalid,
      [
        {
          id,
          name: "new",
          type: "password",
          username: "tester",
          hasSecret: false,
        },
      ],
      {},
    ),
  ).toThrow();
  expect(store.profiles()).toEqual([]);
  expect(store.read()).toEqual(before);
});
it("credentials referenced only by group defaults cannot be deleted and name the correct recovery path", async () => {
  const { store } = await setup();
  const id = randomUUID();
  store.saveSecret(id, "group auth", secret);
  const document = store.read();
  document.groups = [
    {
      id: randomUUID(),
      name: "group",
      parentId: null,
      defaults: { authId: id },
    },
  ];
  store.save(document);
  expect(() => store.deleteSecret(id)).toThrow("그룹 기본값");
  expect(store.getSecret(id)).toEqual(secret);
  document.groups[0].defaults = {};
  store.save(document);
  store.deleteSecret(id);
  expect(store.profiles()).toEqual([]);
});
it.each(["ciphertext", "tag", "nonce"])(
  "portable encryption rejects modified %s without changing the open database",
  async (field) => {
    const { store } = await setup(),
      password = "isolated-test-password";
    const original = store.read();
    const value = JSON.parse(await encodePortable(store.portable(), password));
    value[field] =
      (value[field][0] === "a" ? "b" : "a") + value[field].slice(1);
    await expect(
      decodePortable(JSON.stringify(value), password),
    ).rejects.toThrow();
    expect(store.read()).toEqual(original);
  },
);
it("backup selection rejects traversal and corrupt backups leave live data untouched", async () => {
  const { store, directory } = await setup();
  const original = store.read();
  store.backup();
  expect(() => store.readBackup("../passport.sqlite")).toThrow(
    "백업을 찾을 수 없습니다",
  );
  await fs.writeFile(
    path.join(directory, "backups", store.backups()[0]),
    "{broken",
  );
  expect(() => store.readBackup(store.backups()[0])).toThrow();
  expect(store.read()).toEqual(original);
});
