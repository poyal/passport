import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { ShareService } from "../src/main/share/service";
import { ShareStore } from "../src/main/share/store";
import {
  createIdentity,
  decodeInvite,
  encodeInvite,
  fingerprint,
} from "../src/main/share/identity";
import {
  shareRequest,
  ShareListener,
  json,
  allowedAddress,
} from "../src/main/share/network";
import {
  shareFileName,
  validateMarkdown,
  shareSettingsSchema,
  shareControlSchema,
  shareSendSchema,
  shareOfferSchema,
} from "../src/shared/share";
import { attachmentStream, validateSignature } from "../src/main/share/files";
import { createDarwinDownload } from "../src/main/platform/darwin/download";
import { createWindowsDownload } from "../src/main/platform/win32/download";
import type { Vault } from "../src/main/store";
import https from "node:https";

const cleanups: (() => Promise<unknown>)[] = [];
it("requires message content with optional attachment and rejects mismatched upload metadata", () => {
  expect(
    shareSendSchema.safeParse({ to: "peer", file: "report.pdf" }).success,
  ).toBe(false);
  expect(
    shareSendSchema.safeParse({ to: "peer", text: " \n", file: "report.pdf" })
      .success,
  ).toBe(false);
  expect(
    shareSendSchema.safeParse({
      to: "peer",
      text: "보고서",
      file: "report.pdf",
    }).success,
  ).toBe(true);
  expect(
    shareSendSchema.safeParse({
      to: "peer",
      markdownFile: "message.md",
      file: "report.pdf",
    }).success,
  ).toBe(true);
  expect(
    shareSendSchema.safeParse({
      to: "peer",
      text: "hello",
      markdownFile: "message.md",
    }).success,
  ).toBe(false);
  const offer = {
    id: randomUUID(),
    kind: "message-file",
    name: "report.txt",
    bytes: 1,
    hash: "a".repeat(64),
  };
  expect(shareOfferSchema.safeParse(offer).success).toBe(false);
  expect(
    shareOfferSchema.safeParse({
      ...offer,
      message: { bytes: 262145, hash: "a".repeat(64) },
    }).success,
  ).toBe(false);
  expect(allowedAddress("100.64.0.1")).toBe(false);
});

it("decodes split UTF-8 message bytes without mixing them into the attachment and rejects truncation or tampering", async () => {
  const text = Buffer.from("# 한글 메시지"),
    file = Buffer.from("attachment");
  const message = {
    bytes: text.length,
    hash: createHash("sha256").update(text).digest("hex"),
  };
  const collect = async (chunks: Buffer[], metadata = message) => {
    let markdown: string | undefined;
    const result: Buffer[] = [];
    for await (const chunk of attachmentStream(
      (async function* () {
        yield* chunks;
      })(),
      metadata,
      () => {},
      (value) => {
        markdown = value;
      },
    ))
      result.push(chunk);
    return { markdown, file: Buffer.concat(result) };
  };
  const body = Buffer.concat([text, file]);
  for (const boundary of [1, 3, text.length, text.length + 1]) {
    expect(
      await collect([body.subarray(0, boundary), body.subarray(boundary)]),
    ).toEqual({ markdown: text.toString(), file });
  }
  expect(await collect([text])).toEqual({
    markdown: text.toString(),
    file: Buffer.alloc(0),
  });
  await expect(collect([text.subarray(0, -1)])).rejects.toThrow(/크기/);
  await expect(
    collect([body], { ...message, hash: "0".repeat(64) }),
  ).rejects.toThrow(/무결성/);
});

it("rolls back a protected attachment when its message cannot be stored", async () => {
  const { a, b } = await paired();
  const file = path.join(a.root, "report.txt");
  await fs.writeFile(file, "report");
  vi.spyOn(b.store, "addMessage").mockImplementation(() => {
    throw new Error("message storage full");
  });
  const request = a.service.send({ to: "지수", text: "검토해 주세요", file });
  await vi.waitFor(() =>
    expect(b.service.snapshot().transfers).toHaveLength(1),
  );
  await b.service.approve(request.id, true);
  await vi.waitFor(
    () => expect(a.service.status(request.id).state).toBe("failed"),
    { timeout: 5000 },
  );
  expect(b.store.messages()).toEqual([]);
  expect(await fs.readdir(b.store.settings().receiveDirectory)).toEqual([]);
});

it("reports asynchronous discovery socket failures without throwing or stopping approved direct sharing", async () => {
  const { service, store } = await fixture("discovery failure");
  await service.configure({ ...store.settings(), discoverable: true });
  const mdns = (
    service as unknown as {
      bonjour: { server: { mdns: { emit(name: string, error: Error): void } } };
    }
  ).bonjour.server.mdns;
  expect(() =>
    mdns.emit(
      "error",
      Object.assign(new Error("bind denied"), { code: "EACCES" }),
    ),
  ).not.toThrow();
  expect(service.snapshot().error).toBe(
    "주변 검색을 사용할 수 없습니다. 등록키와 IP로 연결해 주세요.",
  );
  expect(service.snapshot().endpoint?.address).toBe("127.0.0.1");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
const vault = (): Vault => {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([
        nonce,
        cipher.update(text),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
    decryptString: (bytes) => {
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([
        cipher.update(bytes.subarray(12, -16)),
        cipher.final(),
      ]).toString();
    },
  };
};
async function fixture(name: string, secure = vault()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "passport-share-test-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ShareStore(root, secure, root);
  const notices: string[] = [];
  const service = new ShareService(store, {
    protect: async () => {},
    changed: () => {},
    attention: () => {},
    completed: (message) => notices.push(message),
  });
  cleanups.push(() => service.close());
  await service.configure({
    ...store.settings(),
    enabled: true,
    address: "127.0.0.1",
    name,
  });
  return {
    root,
    store,
    service,
    identity: await store.identity(),
    endpoint: service.snapshot().endpoint!,
    notices,
  };
}
async function paired() {
  const a = await fixture("승민"),
    b = await fixture("지수");
  const invite = await b.service.invite();
  await a.service.join(invite.key, "지수");
  await vi.waitFor(() => {
    expect(a.service.snapshot().error).toBeUndefined();
    expect(b.service.snapshot().requests).toHaveLength(1);
  });
  b.service.approvePair(b.service.snapshot().requests[0].id, true, "승민");
  await vi.waitFor(() => expect(a.service.snapshot().peers).toHaveLength(1), {
    timeout: 4000,
  });
  return { a, b };
}
const sendJSON = (
  a: Awaited<ReturnType<typeof fixture>>,
  b: Awaited<ReturnType<typeof fixture>>,
  route: string,
  body: unknown,
) =>
  shareRequest(
    a.identity,
    b.endpoint,
    b.identity.cert,
    route,
    Buffer.from(JSON.stringify(body)),
  );

it("matches completion events to the transfer result once on each device", async () => {
  const { a, b } = await paired();
  const start = async () => {
    a.notices.length = b.notices.length = 0;
    const transfer = a.service.send({ to: "지수", text: "이벤트 확인" });
    await vi.waitFor(() =>
      expect(b.service.snapshot().transfers).toHaveLength(1),
    );
    expect(a.notices).toEqual([]);
    expect(b.notices).toEqual([]);
    return transfer;
  };
  const accepted = await start();
  await b.service.approve(accepted.id, true);
  expect(b.notices).toEqual([]);
  await vi.waitFor(
    () => expect(a.service.status(accepted.id).state).toBe("delivered"),
    { timeout: 5000 },
  );
  expect(a.notices).toEqual(["상대에게 전달했습니다."]);
  expect(b.notices).toEqual(["공유 메시지를 받았습니다."]);
  a.service.cancel(accepted.id);
  expect(a.notices).toHaveLength(1);
  expect(
    a.service.control({ command: "share.cancel", id: accepted.id }),
  ).toMatchObject({ state: "delivered" });
  const rejected = await start();
  await b.service.approve(rejected.id, false);
  await vi.waitFor(
    () => expect(a.service.status(rejected.id).state).toBe("rejected"),
    { timeout: 5000 },
  );
  expect(a.notices).toEqual(["상대가 공유 요청을 거절했습니다."]);
  expect(b.notices).toHaveLength(1); // Receiver wording remains the user's reverted wording; see event audit.
  expect(b.store.messages()).toHaveLength(1);
  const cancelled = await start();
  a.service.cancel(cancelled.id);
  await vi.waitFor(() =>
    expect(b.service.snapshot().transfers).toHaveLength(0),
  );
  expect(a.service.status(cancelled.id).state).toBe("cancelled");
  expect(a.notices).toHaveLength(1);
  expect(b.notices).toHaveLength(1);
  a.service.cancel(cancelled.id);
  expect(a.notices).toHaveLength(1);
  const expired = await start();
  (b.service as any).jobs.get(expired.id).deadline = Date.now() - 1;
  (b.service as any).sweep();
  await vi.waitFor(
    () => expect(a.service.status(expired.id).state).toBe("expired"),
    { timeout: 5000 },
  );
  expect(a.notices).toEqual(["공유 요청이 만료되었습니다."]);
  expect(b.notices).toEqual(["공유 요청이 만료되었습니다."]);
});

it("removes legacy blocked friends on unlock and keeps valid friends without a block flag", async () => {
  const { a, b } = await paired();
  const peer = a.store.peers()[0];
  (a.store as any).put("peer", peer.id, { ...peer, blocked: false });
  expect(a.store.peers()).toEqual([peer]);
  expect(a.store.peers()[0]).not.toHaveProperty("blocked");
  (a.store as any).put("peer", peer.id, { ...peer, blocked: true });
  expect(a.store.peers()).toEqual([]);
  expect(a.store.peers()).toEqual([]);
});

it("shares one identity across concurrent initialization and invalidates pending keys on reset", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-share-identity-"),
  );
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ShareStore(root, vault(), root);
  cleanups.push(async () => store.close());
  const identities = await Promise.all(
    Array.from({ length: 8 }, () => store.identity()),
  );
  expect(
    new Set(identities.map((identity) => fingerprint(identity.cert))).size,
  ).toBe(1);
  store.resetIdentity();
  const pending = expect(store.identity()).rejects.toThrow(/초기화/);
  store.resetIdentity();
  const current = await store.identity();
  await pending;
  expect(await store.identity()).toBe(current);
  expect(fingerprint(current.cert)).not.toBe(fingerprint(identities[0].cert));
});

it("bounds the complete response time even when a trusted peer keeps sending bytes", async () => {
  const [client, server] = await Promise.all([
    createIdentity(),
    createIdentity(),
  ]);
  let respond!: () => void;
  const started = new Promise<void>((resolve) => {
    respond = resolve;
  });
  let response!: import("node:http").ServerResponse;
  const listener = new ShareListener(
    server,
    [client.cert],
    false,
    async (req, res) => {
      req.resume();
      response = res;
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"pending":"');
      respond();
    },
  );
  cleanups.push(() => listener.close());
  const endpoint = await listener.listen("127.0.0.1");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const abort = new AbortController();
  let failure: unknown;
  const result = shareRequest(
    client,
    endpoint,
    server.cert,
    "/pair",
    Buffer.from("{}"),
    abort.signal,
  ).catch((error) => {
    failure = error;
  });
  try {
    await started;
    await vi.advanceTimersByTimeAsync(15000);
    response.write("still-active");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(15000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/시간 초과/);
  } finally {
    abort.abort();
    await result;
  }
});

it("pairs only through an out-of-band invitation and receiver approval; rejects other client keys and replay", async () => {
  const a = await fixture("승민"),
    b = await fixture("지수"),
    stranger = await createIdentity();
  const invitation = decodeInvite((await b.service.invite()).key);
  expect(decodeInvite((await b.service.invite()).key)).toEqual(invitation);
  expect(a.store.settings().name).toBe("Passport 사용자");
  await expect(
    shareRequest(
      a.identity,
      invitation.endpoint,
      invitation.cert,
      "/pair",
      Buffer.from(
        JSON.stringify({
          secret: "0".repeat(64),
          name: "승민",
          port: a.endpoint.port,
        }),
      ),
    ),
  ).rejects.toThrow();
  expect(b.service.snapshot().requests).toEqual([]);
  await a.service.join(encodeInvite(invitation), "지수");
  await vi.waitFor(() => {
    expect(a.service.snapshot().error).toBeUndefined();
    expect(b.service.snapshot().requests).toHaveLength(1);
  });
  expect(b.service.snapshot().peers).toEqual([]);
  expect(decodeInvite((await b.service.invite()).key)).toEqual(invitation);
  expect(() =>
    b.service.approvePair(b.service.snapshot().requests[0].id, true),
  ).toThrow();
  await expect(
    shareRequest(
      stranger,
      invitation.endpoint,
      invitation.cert,
      "/pair",
      Buffer.from(
        JSON.stringify({
          secret: invitation.secret,
          name: "승민",
          port: a.endpoint.port,
        }),
      ),
    ),
  ).rejects.toThrow();
  b.service.approvePair(b.service.snapshot().requests[0].id, true, "승민");
  await vi.waitFor(() => expect(a.service.snapshot().peers).toHaveLength(1), {
    timeout: 4000,
  });
  expect(a.service.snapshot().peers[0].id).toBe(fingerprint(b.identity.cert));
  await expect(
    shareRequest(
      stranger,
      b.endpoint,
      b.identity.cert,
      "/offer",
      Buffer.from("{}"),
    ),
  ).rejects.toThrow();
  await expect(
    shareRequest(
      a.identity,
      b.endpoint,
      stranger.cert,
      "/offer",
      Buffer.from("{}"),
    ),
  ).rejects.toThrow();
  expect(() =>
    decodeInvite(encodeInvite({ ...invitation, expires: Date.now() - 1 })),
  ).toThrow(/만료/);
});

it("does not transfer Markdown before approval and stores accepted messages encrypted", async () => {
  const { a, b } = await paired();
  const text = "# 비밀-TEST-97fc\n\n```sh\nprintf 'hello'\n```\n";
  const transfer = a.service.send({ to: "지수", text });
  await vi.waitFor(() =>
    expect(b.service.snapshot().transfers).toHaveLength(1),
  );
  expect(b.store.messages()).toEqual([]);
  await expect(
    shareRequest(
      a.identity,
      b.endpoint,
      b.identity.cert,
      `/upload/${transfer.id}`,
      Buffer.from(text),
      undefined,
      true,
    ),
  ).rejects.toThrow();
  expect(b.store.messages()).toEqual([]);
  await b.service.approve(transfer.id, true);
  await vi.waitFor(
    () => expect(a.service.status(transfer.id).state).toBe("delivered"),
    { timeout: 5000 },
  );
  expect(b.store.message(transfer.id).markdown).toBe(text);
  const disk = Buffer.concat(
    await Promise.all(
      (await fs.readdir(b.root))
        .filter((f) => f.startsWith("share.sqlite"))
        .map((f) => fs.readFile(path.join(b.root, f))),
    ),
  );
  expect(disk.includes(Buffer.from("비밀-TEST-97fc"))).toBe(false);
  expect(disk.includes(Buffer.from("BEGIN PRIVATE KEY"))).toBe(false);
  expect(a.service.snapshot().transfers).toEqual([]);
  expect(
    shareControlSchema.safeParse({ command: "share.approve", id: transfer.id })
      .success,
  ).toBe(false);
  expect(
    shareControlSchema.safeParse({ command: "share.read", id: transfer.id })
      .success,
  ).toBe(false);
});

it("saves a message and protected attachment together after one approval, rejects replay and preserves existing files", async () => {
  const { a, b } = await paired();
  const source = path.join(a.root, "보고서.html"),
    data = "<script>throw new Error('must never run')</script>";
  await fs.writeFile(source, data);
  await fs.mkdir(b.store.settings().receiveDirectory, { recursive: true });
  await fs.writeFile(
    path.join(b.store.settings().receiveDirectory, "보고서.html"),
    "existing",
  );
  const text = "# 보고서 검토 요청\n\n첨부 문서를 확인해 주세요.";
  const transfer = a.service.send({ to: "지수", text, file: source });
  await vi.waitFor(() =>
    expect(b.service.snapshot().transfers).toHaveLength(1),
  );
  expect(b.store.messages()).toEqual([]);
  expect(b.service.snapshot().transfers[0].kind).toBe("message-file");
  await b.service.approve(transfer.id, true);
  await vi.waitFor(
    () => expect(a.service.status(transfer.id).state).toBe("delivered"),
    { timeout: 5000 },
  );
  expect(
    await fs.readFile(
      path.join(b.store.settings().receiveDirectory, "보고서.html"),
      "utf8",
    ),
  ).toBe("existing");
  expect(
    await fs.readFile(
      path.join(b.store.settings().receiveDirectory, "보고서 (1).html"),
      "utf8",
    ),
  ).toBe(data);
  expect(await fs.readdir(b.store.settings().receiveDirectory)).toEqual([
    "보고서 (1).html",
    "보고서.html",
  ]);
  expect(b.store.message(transfer.id)).toMatchObject({
    markdown: text,
    attachment: {
      name: "보고서.html",
      path: path.join(b.store.settings().receiveDirectory, "보고서 (1).html"),
      bytes: Buffer.byteLength(data),
    },
  });
  await expect(
    sendJSON(a, b, "/offer", {
      id: transfer.id,
      name: "보고서.html",
      kind: "file",
      bytes: Buffer.byteLength(data),
      hash: createHash("sha256").update(data).digest("hex"),
    }),
  ).rejects.toThrow();
});

it("binds approval to the sender and digest and revokes trust when a peer is deleted", async () => {
  const { a, b } = await paired();
  const id = randomUUID();
  await sendJSON(a, b, "/offer", {
    id,
    kind: "markdown",
    name: "검사",
    bytes: 4,
    hash: createHash("sha256").update("good").digest("hex"),
  });
  await b.service.approve(id, true);
  await shareRequest(
    a.identity,
    b.endpoint,
    b.identity.cert,
    `/upload/${id}`,
    Buffer.from("evil"),
    undefined,
    true,
  ).catch(() => {});
  expect(b.store.messages()).toEqual([]);
  const transfer = a.service.send({ to: "지수", text: "대기 중" });
  await vi.waitFor(() =>
    expect(b.service.snapshot().transfers).toHaveLength(1),
  );
  b.service.updatePeer(fingerprint(a.identity.cert), { remove: true });
  expect(b.service.snapshot().transfers).toEqual([]);
  await expect(b.service.approve(transfer.id, true)).rejects.toThrow();
  await expect(sendJSON(a, b, `/status/${transfer.id}`, {})).rejects.toThrow();
});

it("rejects dangerous filenames, non-UTF8/control messages and mismatched signatures", () => {
  for (const name of [
    "../a.md",
    "a\\b.md",
    "/a.md",
    "NUL.txt",
    "COM¹.txt",
    "LPT².pdf",
    "CON .txt",
    "CONIN$.txt",
    "CONOUT$.txt",
    "x.txt:evil",
    "a.md.exe",
    " a.md",
    "a.md.",
    "x\u202eexe.md",
    "x.svg",
  ])
    expect(() => shareFileName(name)).toThrow();
  for (const name of ["한글.md", "보고서.html", "문서.hwpx", "archive.7z"])
    expect(shareFileName(name)).toBe(name);
  expect(() => validateSignature("image.png", Buffer.from("MZfake"))).toThrow();
  expect(() => validateMarkdown("\x1b]52;c;evil\x07")).toThrow();
  expect(() => validateMarkdown("가".repeat(100000))).toThrow();
  for (const address of ["0.0.0.0", "8.8.8.8", "example.com", "127.0.0.1.evil"])
    expect(allowedAddress(address)).toBe(false);
});

it("retention removes only expired encrypted messages and encryption failures prevent sharing", async () => {
  const a = await fixture("승민");
  const old = {
    id: randomUUID(),
    title: "old",
    markdown: "secret",
    peerName: "지수",
    created: Date.now() - 8 * 86400000,
  };
  a.store.saveSettings({ ...a.store.settings(), retentionDays: null });
  a.store.addMessage(old);
  expect(a.store.messages()).toHaveLength(1);
  a.store.saveSettings({ ...a.store.settings(), retentionDays: 7 });
  expect(a.store.messages()).toEqual([]);
  expect(shareSettingsSchema.safeParse({ retentionDays: 31 }).success).toBe(
    false,
  );
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-share-locked-"),
  );
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const secure = vault();
  secure.isEncryptionAvailable = () => false;
  const store = new ShareStore(root, secure, root);
  const service = new ShareService(store, {
    protect: async () => {},
    changed: () => {},
    attention: () => {},
  });
  cleanups.push(() => service.close());
  await expect(
    service.configure({
      ...store.settings(),
      enabled: true,
      address: "127.0.0.1",
    }),
  ).rejects.toThrow(/암호화/);
  expect(service.enabled).toBe(false);
});

it("marks macOS downloads and keeps Windows paths out of executable script text", async () => {
  if (process.platform === "darwin") {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "passport-share-mark-"),
    );
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, "download.md");
    await fs.writeFile(file, "# hello");
    await createDarwinDownload()(file);
  }
  const run = vi.fn(
    async (_file: string, _args: string[], _input?: string) => "",
  );
  const malicious = "C:\\Users\\name\\file';$(bad).html";
  await createWindowsDownload(run, { SystemRoot: "C:\\Windows" })(malicious);
  expect(run.mock.calls[0][1]).not.toContain(malicious);
  expect(JSON.parse(run.mock.calls[0][2]!.trim())).toEqual({ path: malicious });
  const script = Buffer.from(run.mock.calls[0][1].at(-1)!, "base64").toString(
    "utf16le",
  );
  expect(script).toContain("attachment.Save();");
  expect(script).toContain(
    "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)",
  );
  expect(script).not.toContain("attachment.Execute(");
});

it.skipIf(process.platform !== "win32")(
  "marks real Windows attachments with ZoneId 3 while preserving literal filenames and content",
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "passport-share-zone-"),
    );
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, "한글 ' [literal] ; $(not-a-command).txt");
    const content = "Harmless Passport download protection fixture.\r\n";
    await fs.writeFile(file, content);
    await createWindowsDownload()(file);
    expect(await fs.readFile(file, "utf8")).toBe(content);
    expect(await fs.readFile(`${file}:Zone.Identifier`, "utf8")).toBe(
      "[ZoneTransfer]\r\nZoneId=3\r\n",
    );
    await expect(
      createWindowsDownload()(path.join(root, "missing.txt")),
    ).rejects.toThrow(/다운로드 보호/);
    expect(await fs.readdir(root)).toEqual([path.basename(file)]);
  },
);

it("keeps the paired endpoint across configuration changes and recovers only owned interrupted downloads", async () => {
  const { a, b } = await paired();
  const directory = await fs.realpath(b.store.settings().receiveDirectory);
  const staging = await fs.mkdtemp(path.join(directory, ".passport-receive-"));
  await b.store.trackStaging(staging);
  await fs.writeFile(path.join(staging, "unfinished.md"), "partial");
  await fs.writeFile(path.join(directory, "saved.md"), "keep");
  const unrelated = await fs.mkdtemp(
    path.join(directory, ".passport-receive-"),
  );
  await b.service.configure({ ...b.store.settings(), retentionDays: 30 });
  expect(b.service.snapshot().endpoint).toEqual(b.endpoint);
  expect(await fs.readdir(directory)).toEqual(
    [path.basename(unrelated), "saved.md"].sort(),
  );
  const request = a.service.send({ to: "지수", text: "after restart" });
  await vi.waitFor(() =>
    expect(b.service.snapshot().transfers).toHaveLength(1),
  );
  await b.service.approve(request.id, false);
  await vi.waitFor(
    () => expect(a.service.status(request.id).state).toBe("rejected"),
    { timeout: 4000 },
  );
});

it("fails closed if OS attachment protection is unavailable and cleans partial data", async () => {
  const { a, b } = await paired();
  const file = path.join(a.root, "document.md");
  await fs.writeFile(file, "# private");
  // Inject only the OS boundary, keeping the real protocol, staging and digest.
  (b.service as any).options.protect = async () => {
    throw new Error("quarantine unavailable");
  };
  const request = a.service.send({ to: "지수", text: "첨부 문서", file });
  await vi.waitFor(() =>
    expect(b.service.snapshot().transfers).toHaveLength(1),
  );
  await b.service.approve(request.id, true);
  await vi.waitFor(
    () => expect(a.service.status(request.id).state).toBe("failed"),
    { timeout: 5000 },
  );
  expect(await fs.readdir(b.store.settings().receiveDirectory)).toEqual([]);
  expect(b.store.messages()).toEqual([]);
  await b.store.recoverStaging();
});

it("rejects absent client certificates and TLS downgrade, and revokes old identities on reset", async () => {
  const { a, b } = await paired();
  const probe = (legacy: boolean) =>
    new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          hostname: b.endpoint.address,
          port: b.endpoint.port,
          servername: "passport-share",
          ca: b.identity.cert,
          method: "POST",
          path: "/offer",
          ...(legacy ? { ...a.identity, maxVersion: "TLSv1.2" as const } : {}),
          headers: { "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on("error", reject);
      req.setTimeout(2000, () => req.destroy(new Error("timeout")));
      req.end("{}");
    });
  await expect(probe(false)).rejects.toThrow();
  await expect(probe(true)).rejects.toThrow();
  const id = randomUUID();
  b.store.addMessage({
    id,
    title: "keep",
    markdown: "# preserved",
    peerName: "승민",
    created: Date.now(),
  });
  const old = fingerprint(b.identity.cert);
  let finishUnlock!: (identity: typeof b.identity) => void;
  vi.spyOn(b.store, "identity").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishUnlock = resolve;
      }),
  );
  const staleUnlock = expect(b.service.unlock()).rejects.toThrow(/변경/);
  await b.service.resetIdentity();
  finishUnlock(b.identity);
  await staleUnlock;
  expect(b.service.enabled).toBe(false);
  expect(b.service.snapshot().peers).toEqual([]);
  expect(b.store.message(id).markdown).toBe("# preserved");
  await b.service.configure({ ...b.store.settings(), enabled: true });
  expect(fingerprint((await b.store.identity()).cert)).not.toBe(old);
  await expect(
    shareRequest(
      a.identity,
      b.service.snapshot().endpoint!,
      b.identity.cert,
      "/offer",
      Buffer.from("{}"),
    ),
  ).rejects.toThrow();
});

it("does not retain private source paths in failed completion receipts", async () => {
  const { a } = await paired();
  const file = path.join(a.root, "private-customer-document.pdf");
  const request = a.service.send({ to: "지수", text: "첨부 문서", file });
  await vi.waitFor(() =>
    expect(a.service.status(request.id).state).toBe("failed"),
  );
  expect(JSON.stringify(a.service.status(request.id))).not.toContain(file);
  expect(JSON.stringify(a.service.status(request.id))).not.toContain(
    "private-customer",
  );
  expect(a.service.status(request.id).error).toContain("ENOENT");
});
