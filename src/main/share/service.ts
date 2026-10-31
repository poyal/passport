import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type Bonjour from "bonjour-service";
import { createDiscovery } from "./discovery";
import { z } from "zod";
import {
  shareOfferSchema,
  shareSettingsSchema,
  shareSendSchema,
  shareEndpointSchema,
  shareLabel,
  shareOfferLifetime,
  shareInviteLifetime,
  shareTextLimit,
  shareFileName,
  validateMarkdown,
  type ShareSettings,
  type ShareSnapshot,
  type ShareEndpoint,
  type ShareTransfer,
  type ShareOffer,
  type ShareSend,
  type ShareControlCommand,
} from "../../shared/share";
import { ShareStore, type StoredPeer } from "./store";
import {
  fingerprint,
  encodeInvite,
  decodeInvite,
  sameSecret,
  type ShareIdentity,
  type ShareInvite,
} from "./identity";
import {
  ShareListener,
  shareRequest,
  readJSON,
  json,
  interfaces,
  allowedAddress,
} from "./network";
import {
  attachmentStream,
  readSendFile,
  receiveFile,
  secureDirectory,
  validateSignature,
} from "./files";

type Job = {
  view: ShareTransfer;
  offer?: ShareOffer;
  abort: AbortController;
  data?: Buffer;
  peer: StoredPeer;
  directory?: string;
  deadline: number;
  receipt?: number;
  request?: IncomingMessage;
};
type Pairing = {
  invite: ShareInvite;
  request?: {
    id: string;
    name: string;
    cert: string;
    endpoint: ShareEndpoint;
    state: "pending" | "approved" | "rejected";
  };
};
const pairSchema = z
  .object({
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    name: shareLabel,
    port: z.number().int().min(1).max(65535),
  })
  .strict();
const resultSchema = z
  .object({
    state: z.enum([
      "pending",
      "accepted",
      "sending",
      "delivered",
      "rejected",
      "expired",
      "cancelled",
      "failed",
    ]),
    id: z.string().uuid().optional(),
    endpoint: shareEndpointSchema.optional(),
  })
  .strict();
const done = new Set([
  "delivered",
  "rejected",
  "expired",
  "cancelled",
  "failed",
]);
function publicError(error: unknown, fallback: string) {
  // OS errors may include a local path or filename. Do not retain those in
  // short-lived completion receipts or expose them in status notifications.
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code && /^[A-Z0-9_]+$/.test(code)
    ? `${fallback} (${code})`
    : error instanceof Error
      ? error.message
      : fallback;
}

export class ShareService {
  private identity?: ShareIdentity;
  private listener?: ShareListener;
  private pairListener?: ShareListener;
  private pairing?: Pairing;
  private endpoint?: ShareEndpoint;
  private peers: StoredPeer[] = [];
  private jobs = new Map<string, Job>();
  private joins = new Set<AbortController>();
  private tasks = new Set<Promise<unknown>>();
  private bonjour?: Bonjour;
  private discoveryBrowser?: ReturnType<Bonjour["find"]>;
  private nextDiscoveryQuery = 0;
  private nearby = new Map<
    string,
    { name: string; endpoint: ShareEndpoint; seen: number; instance: string }
  >();
  private timer: ReturnType<typeof setInterval>;
  private errorValue?: string;
  private errorId?: string;
  private get error() {
    return this.errorValue;
  }
  private set error(value: string | undefined) {
    this.errorValue = value;
    this.errorId = value ? randomUUID() : undefined;
  }
  private unlocked = false;
  private configuration: Promise<void> = Promise.resolve();
  private closed = false;
  private epoch = 0;
  private inviting = false;
  private rates = new Map<string, number[]>();
  constructor(
    readonly store: ShareStore,
    private options: {
      protect(file: string): Promise<void>;
      changed(): void;
      attention(): void;
      completed?(message: string, level: "info" | "error"): void;
    },
  ) {
    this.timer = setInterval(() => this.sweep(), 10000);
    this.timer.unref();
  }
  get enabled() {
    return !!this.listener && !!this.endpoint && !this.closed;
  }
  snapshot(): ShareSnapshot {
    return {
      settings: this.store.settings(),
      endpoint: this.endpoint,
      peers: this.peers.map(({ cert: _, ...peer }) => peer),
      requests:
        this.pairing?.request?.state === "pending" &&
        this.pairing.invite.expires > Date.now()
          ? [
              {
                id: this.pairing.request.id,
                name: this.pairing.request.name,
                fingerprint: fingerprint(this.pairing.request.cert),
                expires: this.pairing.invite.expires,
              },
            ]
          : [],
      transfers: [...this.jobs.values()]
        .filter((j) => !done.has(j.view.state))
        .map((j) => ({ ...j.view })),
      messages: this.unlocked ? this.store.messages() : [],
      nearby: [...this.nearby.values()].map(
        ({ seen: _, instance: __, ...peer }) => peer,
      ),
      interfaces: interfaces(),
      error: this.error,
      errorId: this.errorId,
    };
  }
  dismissError(errorId: string) {
    if (this.errorId === errorId) {
      this.error = undefined;
      this.changed();
    }
    return this.snapshot();
  }
  private changed() {
    if (!this.closed) this.options.changed();
  }
  private track<T>(work: Promise<T>): Promise<T> {
    const task = work.finally(() => this.tasks.delete(task));
    this.tasks.add(task);
    return task;
  }
  async configure(input: ShareSettings) {
    const settings = shareSettingsSchema.parse(input);
    const work = async () => {
      await this.stop();
      this.error = undefined;
      if (settings.enabled) {
        if (!interfaces().some((i) => i.address === settings.address))
          throw new Error("사용할 LAN 네트워크를 선택하세요.");
        await secureDirectory(settings.receiveDirectory);
        this.identity = await this.store.identity();
        await this.store.recoverStaging();
        this.peers = this.store.peers();
        this.unlocked = true;
        const listener = new ShareListener(
          this.identity,
          this.trusted(),
          false,
          (req, res, remote) => this.track(this.handle(req, res, remote.id)),
        );
        try {
          this.endpoint = await listener.listen(
            settings.address,
            this.store.listenerPort(),
          );
          this.store.saveListenerPort(this.endpoint.port);
          this.listener = listener;
        } catch (error) {
          await listener.close();
          throw error;
        }
      }
      this.store.saveSettings(settings);
      if (settings.enabled && settings.discoverable)
        this.startDiscovery(settings);
      this.changed();
    };
    this.configuration = this.configuration
      .catch(() => {})
      .then(work)
      .catch(async (error) => {
        await this.stop();
        this.store.saveSettings({ ...settings, enabled: false });
        this.error = publicError(error, "쪽지를 시작할 수 없습니다.");
        this.changed();
        throw error;
      });
    await this.configuration;
    return this.snapshot();
  }
  async unlock() {
    const epoch = this.epoch;
    const identity = await this.store.identity();
    if (this.closed || epoch !== this.epoch)
      throw new Error("쪽지 설정이 변경되었습니다. 다시 시도하세요.");
    this.identity = identity;
    this.peers = this.store.peers();
    this.unlocked = true;
    return this.snapshot();
  }
  async resetIdentity() {
    const work = async () => {
      await this.stop();
      await this.store.recoverStaging();
      this.store.resetIdentity();
      this.identity = undefined;
      this.peers = [];
      this.store.saveSettings({ ...this.store.settings(), enabled: false });
      this.error = undefined;
      this.changed();
    };
    this.configuration = this.configuration.catch(() => {}).then(work);
    await this.configuration;
    return this.snapshot();
  }
  private trusted() {
    return this.peers.map((p) => p.cert);
  }
  private requireEnabled() {
    if (!this.enabled || !this.identity || !this.endpoint)
      throw new Error("설정에서 쪽지를 켜 주세요.");
    return this.identity;
  }
  private peer(id: string) {
    this.requireEnabled();
    const peer = this.peers.find((p) => p.id === id);
    if (!peer) throw new Error("등록되지 않은 상대입니다.");
    return peer;
  }
  private rate(key: string, max = 20) {
    const now = Date.now(),
      calls = (this.rates.get(key) ?? []).filter((t) => now - t < 60000);
    if (calls.length >= max || (this.rates.size >= 256 && !this.rates.has(key)))
      throw new Error("요청이 너무 많습니다.");
    calls.push(now);
    this.rates.set(key, calls);
  }
  async invite() {
    const identity = this.requireEnabled();
    if (
      this.pairing &&
      this.pairing.invite.expires > Date.now() &&
      (!this.pairing.request || this.pairing.request.state === "pending")
    )
      return {
        key: encodeInvite(this.pairing.invite),
        expires: this.pairing.invite.expires,
      };
    if (this.inviting) throw new Error("등록키를 만드는 중입니다.");
    this.inviting = true;
    const epoch = this.epoch;
    try {
      await this.pairListener?.close();
      this.pairing = undefined;
      this.requireEnabled();
      if (epoch !== this.epoch) throw new Error("쪽지 설정이 변경되었습니다.");
      const listener = new ShareListener(
        identity,
        [],
        true,
        (req, res, remote) => this.handlePair(req, res, remote),
      );
      this.pairListener = listener;
      const endpoint = await listener.listen(this.store.settings().address);
      if (epoch !== this.epoch || !this.enabled) {
        await listener.close();
        throw new Error("쪽지 설정이 변경되었습니다.");
      }
      const invite = {
        version: 1 as const,
        endpoint,
        cert: identity.cert,
        secret: randomBytes(32).toString("hex"),
        expires: Date.now() + shareInviteLifetime,
      };
      this.pairing = { invite };
      this.changed();
      return { key: encodeInvite(invite), expires: invite.expires };
    } finally {
      this.inviting = false;
    }
  }
  private async handlePair(
    req: IncomingMessage,
    res: ServerResponse,
    remote: { id: string; cert: string },
  ) {
    this.requireEnabled();
    if (req.url !== "/pair") throw new Error("등록 요청만 허용됩니다.");
    this.rate("pair:" + req.socket.remoteAddress, 120);
    const input = pairSchema.parse(await readJSON(req));
    const pair = this.pairing;
    if (
      !pair ||
      pair.invite.expires <= Date.now() ||
      !sameSecret(pair.invite.secret, input.secret) ||
      remote.id === fingerprint(this.identity!.cert)
    )
      throw new Error("등록키가 일치하지 않습니다.");
    const address = req.socket.remoteAddress!;
    if (!allowedAddress(address)) throw new Error("허용되지 않은 주소입니다.");
    if (!pair.request) {
      if (this.peers.some((p) => p.id === remote.id))
        throw new Error(
          "이미 등록된 기기입니다. 기존 등록을 해제한 뒤 다시 등록하세요.",
        );
      pair.request = {
        id: randomUUID(),
        name: input.name,
        cert: remote.cert,
        endpoint: { address, port: input.port },
        state: "pending",
      };
      this.options.attention();
      this.changed();
    }
    if (
      fingerprint(pair.request.cert) !== remote.id ||
      pair.request.endpoint.port !== input.port ||
      pair.request.endpoint.address !== address ||
      pair.request.name !== input.name
    )
      throw new Error("등록키가 다른 기기에 사용되었습니다.");
    json(res, {
      state: pair.request.state,
      id: pair.request.id,
      ...(pair.request.state === "approved" ? { endpoint: this.endpoint } : {}),
    });
  }
  approvePair(id: string, accept: boolean, alias?: string) {
    this.requireEnabled();
    const pair = this.pairing;
    if (
      !pair ||
      !pair.request ||
      pair.request.id !== id ||
      pair.request.state !== "pending" ||
      pair.invite.expires <= Date.now()
    )
      throw new Error("등록 요청이 만료되었습니다.");
    if (accept) {
      if (this.peers.length >= 100)
        throw new Error("사용자는 100명까지 등록할 수 있습니다.");
      const peer: StoredPeer = {
        id: fingerprint(pair.request.cert),
        cert: pair.request.cert,
        name: shareLabel.parse(alias),
        endpoint: pair.request.endpoint,
      };
      this.store.savePeer(peer);
      this.peers.push(peer);
      this.listener!.trust(this.identity!, this.trusted());
    }
    pair.request.state = accept ? "approved" : "rejected";
    this.changed();
  }
  async join(key: string, alias: string) {
    if (this.peers.length >= 100)
      throw new Error("사용자는 100명까지 등록할 수 있습니다.");
    const identity = this.requireEnabled(),
      invite = decodeInvite(key),
      name = shareLabel.parse(alias);
    if (this.joins.size) throw new Error("등록 요청을 처리 중입니다.");
    const id = fingerprint(invite.cert);
    if (
      id === fingerprint(identity.cert) ||
      this.peers.some((p) => p.id === id)
    )
      throw new Error("이미 등록된 기기이거나 본인 기기입니다.");
    const abort = new AbortController();
    this.joins.add(abort);
    const body = Buffer.from(
      JSON.stringify({
        secret: invite.secret,
        name: this.store.settings().name,
        port: this.endpoint!.port,
      }),
    );
    // Background polling keeps UI IPC bounded while the other human approves.
    void this.track(
      (async () => {
        try {
          while (Date.now() < invite.expires) {
            const result = z
              .object({
                state: z.enum(["pending", "approved", "rejected"]),
                id: z.string().uuid(),
                endpoint: shareEndpointSchema.optional(),
              })
              .strict()
              .parse(
                await shareRequest(
                  identity,
                  invite.endpoint,
                  invite.cert,
                  "/pair",
                  body,
                  abort.signal,
                ),
              );
            this.requireEnabled();
            if (abort.signal.aborted) throw new Error("등록이 취소되었습니다.");
            if (result.state === "rejected")
              throw new Error("상대가 등록을 거절했습니다.");
            if (result.state === "approved" && result.endpoint) {
              // Only the host authenticated by the invitation may become the peer.
              const peer = {
                id,
                name,
                cert: invite.cert,
                endpoint: {
                  address: invite.endpoint.address,
                  port: result.endpoint.port,
                },
              };
              this.store.savePeer(peer);
              this.peers.push(peer);
              this.listener!.trust(identity, this.trusted());
              this.changed();
              return;
            }
            await delay(2000, undefined, { signal: abort.signal });
          }
          throw new Error("등록 요청이 만료되었습니다.");
        } catch (error) {
          if (!abort.signal.aborted) {
            this.error = publicError(error, "등록에 실패했습니다.");
            this.changed();
          }
        } finally {
          this.joins.delete(abort);
        }
      })(),
    );
  }
  updatePeer(
    id: string,
    input: {
      name?: string;
      remove?: boolean;
      endpoint?: ShareEndpoint;
    },
  ) {
    const peer = this.peers.find((p) => p.id === id);
    if (!peer) throw new Error("상대를 찾을 수 없습니다.");
    const addressChanged =
      !!input.endpoint &&
      (input.endpoint.address !== peer.endpoint.address ||
        input.endpoint.port !== peer.endpoint.port);
    if (input.remove) {
      this.store.removePeer(id);
      this.peers = this.peers.filter((p) => p.id !== id);
    } else {
      const next = { ...peer };
      if (input.name !== undefined) next.name = shareLabel.parse(input.name);
      if (input.endpoint) {
        const endpoint = shareEndpointSchema.parse(input.endpoint);
        if (!allowedAddress(endpoint.address))
          throw new Error("LAN 주소만 사용할 수 있습니다.");
        next.endpoint = endpoint;
      }
      this.store.savePeer(next);
      Object.assign(peer, next);
    }
    if (input.remove || addressChanged)
      for (const job of this.jobs.values())
        if (job.peer.id === id)
          this.finish(
            job,
            "cancelled",
            input.remove
              ? "친구를 삭제해 쪽지 전송을 취소했습니다."
              : "친구의 연결 주소가 변경되어 쪽지 전송을 취소했습니다.",
          );
    if ((input.remove || addressChanged) && this.listener && this.identity) {
      this.listener.trust(this.identity, this.trusted());
      this.listener.disconnect();
    }
    this.changed();
  }
  private async handle(req: IncomingMessage, res: ServerResponse, id: string) {
    const peer = this.peer(id);
    const epoch = this.epoch;
    if (req.url === "/offer") {
      this.rate(id);
      const offer = shareOfferSchema.parse(await readJSON(req));
      if (epoch !== this.epoch || this.peer(id) !== peer)
        throw new Error("쪽지 설정이 변경되었습니다.");
      if (offer.kind !== "markdown") shareFileName(offer.name);
      if (this.jobs.has(offer.id))
        throw new Error("이미 사용한 전송 ID입니다.");
      if (
        [...this.jobs.values()].filter(
          (j) => !done.has(j.view.state) && j.view.direction === "incoming",
        ).length >= 20
      )
        throw new Error("승인 대기 요청이 너무 많습니다.");
      const view: ShareTransfer = {
        ...offer,
        peerId: id,
        peerName: peer.name,
        direction: "incoming",
        state: "pending",
        received: 0,
        created: Date.now(),
      };
      this.jobs.set(offer.id, {
        view,
        offer,
        peer,
        abort: new AbortController(),
        deadline: Date.now() + shareOfferLifetime,
      });
      this.options.attention();
      this.changed();
      json(res, { id: offer.id, state: "pending" });
      return;
    }
    const match = /^\/(status|upload|cancel)\/([a-f0-9-]{36})$/.exec(
      req.url ?? "",
    );
    if (!match) throw new Error("지원하지 않는 쪽지 요청입니다.");
    const job = this.jobs.get(match[2]);
    if (!job || job.peer.id !== id || job.view.direction !== "incoming")
      throw new Error("허용되지 않은 전송입니다.");
    if (match[1] === "status") {
      await readJSON(req);
      this.expire(job);
      json(res, { state: job.view.state });
      return;
    }
    if (match[1] === "cancel") {
      await readJSON(req);
      this.finish(job, "cancelled");
      json(res, { state: job.view.state });
      return;
    }
    this.expire(job);
    if (
      job.view.state !== "accepted" ||
      !job.offer ||
      req.headers["content-type"] !== "application/octet-stream" ||
      req.headers["content-encoding"] ||
      req.headers["content-length"] !==
        String(job.offer.bytes + (job.offer.message?.bytes ?? 0))
    )
      throw new Error("먼저 수신 승인이 필요합니다.");
    if (
      [...this.jobs.values()].filter(
        (j) => j.view.direction === "incoming" && j.view.state === "sending",
      ).length >= 2
    )
      throw new Error("동시 수신 제한을 초과했습니다.");
    job.view.state = "sending";
    job.request = req;
    this.changed();
    const valid = () => {
      this.peer(id);
      if (
        job.abort.signal.aborted ||
        job.view.state !== "sending" ||
        Date.now() >= job.deadline
      )
        throw new Error("전송이 취소되었거나 만료되었습니다.");
    };
    try {
      if (job.offer.kind === "markdown") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          valid();
          size += chunk.length;
          if (size > job.offer.bytes) throw new Error("쪽지 크기가 다릅니다.");
          chunks.push(chunk);
        }
        const data = Buffer.concat(chunks);
        if (
          size !== job.offer.bytes ||
          createHash("sha256").update(data).digest("hex") !== job.offer.hash
        )
          throw new Error("쪽지 무결성 검사에 실패했습니다.");
        const markdown = validateMarkdown(
          new TextDecoder("utf-8", { fatal: true }).decode(data),
        );
        valid();
        this.store.addMessage({
          id: job.view.id,
          title:
            markdown.trim().split(/\r?\n/, 1)[0].slice(0, 100) ||
            job.offer.name,
          peerName: peer.name,
          created: Date.now(),
          markdown,
        });
      } else {
        let markdown: string | undefined;
        const offer = job.offer;
        await receiveFile(
          offer.message
            ? attachmentStream(req, offer.message, valid, (text) => {
                markdown = text;
              })
            : req,
          offer,
          job.directory!,
          this.options.protect,
          valid,
          (bytes) => {
            job.view.received = bytes;
          },
          (directory) => this.store.trackStaging(directory),
          offer.message
            ? (destination) => {
                if (markdown === undefined)
                  throw new Error("첨부 쪽지가 없습니다.");
                this.store.addMessage({
                  id: job.view.id,
                  title: markdown.trim().split(/\r?\n/, 1)[0].slice(0, 100),
                  peerName: peer.name,
                  created: Date.now(),
                  markdown,
                  attachment: {
                    name: offer.name,
                    path: destination,
                    bytes: offer.bytes,
                  },
                });
              }
            : undefined,
        );
      }
      this.finish(job, "delivered");
      json(res, { state: "delivered" });
    } catch (error) {
      this.finish(job, "failed", publicError(error, "수신에 실패했습니다."));
      json(res, { state: "failed" });
    } finally {
      job.request = undefined;
    }
  }
  async approve(id: string, accept: boolean, authorize?: () => void) {
    authorize?.();
    const job = this.jobs.get(id);
    if (
      !job ||
      job.view.direction !== "incoming" ||
      job.view.state !== "pending"
    )
      throw new Error("승인할 요청이 없습니다.");
    this.peer(job.peer.id);
    this.expire(job);
    if (job.view.state !== "pending") throw new Error("요청이 만료되었습니다.");
    if (!accept) {
      this.finish(job, "rejected");
      return;
    }
    if (job.offer && job.offer.kind !== "markdown")
      job.directory = await secureDirectory(
        this.store.settings().receiveDirectory,
      );
    authorize?.();
    this.peer(job.peer.id);
    this.expire(job);
    if (job.view.state !== "pending")
      throw new Error("요청이 취소되었거나 만료되었습니다.");
    job.view.state = "accepted";
    this.changed();
  }
  send(raw: ShareSend) {
    this.requireEnabled();
    const input = shareSendSchema.parse(raw);
    const matches = this.peers.filter(
      (p) => p.id === input.to || p.name === input.to,
    );
    if (matches.length !== 1)
      throw new Error(
        "상대 이름이 없거나 중복됩니다. 정확한 기기 ID를 사용하세요.",
      );
    const peer = this.peer(matches[0].id);
    if (
      [...this.jobs.values()].filter(
        (j) => j.view.direction === "outgoing" && !done.has(j.view.state),
      ).length >= 2
    )
      throw new Error("동시 전송은 2개까지 가능합니다.");
    const id = randomUUID();
    const job: Job = {
      peer: { ...peer },
      abort: new AbortController(),
      deadline: Date.now() + shareOfferLifetime,
      view: {
        id,
        peerId: peer.id,
        peerName: peer.name,
        direction: "outgoing",
        state: "preparing",
        kind: input.file ? "message-file" : "markdown",
        name: input.file ? path.basename(input.file) : "Markdown 쪽지",
        bytes: 0,
        received: 0,
        created: Date.now(),
      },
    };
    this.jobs.set(id, job);
    this.changed();
    void this.track(this.sendJob(job, input));
    return { id, state: "preparing" };
  }
  private async sendJob(job: Job, input: ShareSend) {
    try {
      const identity = this.requireEnabled();
      const message = input.markdownFile
        ? Buffer.from(
            validateMarkdown(
              new TextDecoder("utf-8", { fatal: true }).decode(
                await readSendFile(input.markdownFile, shareTextLimit),
              ),
            ),
          )
        : Buffer.from(validateMarkdown(input.text!));
      if (!message.toString().trim()) throw new Error("쪽지를 입력하세요.");
      const file = input.file ? await readSendFile(input.file) : undefined;
      const data = file ? Buffer.concat([message, file]) : message;
      this.peer(job.peer.id);
      job.abort.signal.throwIfAborted();
      if (input.file) {
        shareFileName(job.view.name);
        validateSignature(job.view.name, file!.subarray(0, 4096));
      }
      job.data = data;
      const offer = shareOfferSchema.parse({
        id: job.view.id,
        kind: job.view.kind,
        name: job.view.name,
        bytes: (file ?? message).length,
        hash: createHash("sha256")
          .update(file ?? message)
          .digest("hex"),
        ...(file
          ? {
              message: {
                bytes: message.length,
                hash: createHash("sha256").update(message).digest("hex"),
              },
            }
          : {}),
      });
      job.offer = offer;
      job.view.bytes = data.length;
      resultSchema.parse(
        await shareRequest(
          identity,
          job.peer.endpoint,
          job.peer.cert,
          "/offer",
          Buffer.from(JSON.stringify(offer)),
          job.abort.signal,
        ),
      );
      job.abort.signal.throwIfAborted();
      job.view.state = "pending";
      this.changed();
      while (Date.now() < job.deadline) {
        this.peer(job.peer.id);
        job.abort.signal.throwIfAborted();
        const result = resultSchema.parse(
          await shareRequest(
            identity,
            job.peer.endpoint,
            job.peer.cert,
            `/status/${job.view.id}`,
            Buffer.from("{}"),
            job.abort.signal,
          ),
        );
        job.abort.signal.throwIfAborted();
        if (result.state === "accepted") {
          job.view.state = "sending";
          this.changed();
          const final = resultSchema.parse(
            await shareRequest(
              identity,
              job.peer.endpoint,
              job.peer.cert,
              `/upload/${job.view.id}`,
              data,
              job.abort.signal,
              true,
            ),
          );
          this.finish(
            job,
            final.state === "delivered" ? "delivered" : "failed",
          );
          return;
        }
        if (done.has(result.state)) {
          this.finish(
            job,
            result.state as "rejected" | "expired" | "cancelled" | "failed",
          );
          return;
        }
        await delay(2000, undefined, { signal: job.abort.signal });
      }
      this.finish(job, "expired");
    } catch (error) {
      if (!done.has(job.view.state))
        this.finish(job, "failed", publicError(error, "전송에 실패했습니다."));
    } finally {
      job.data = undefined;
    }
  }
  private finish(
    job: Job,
    state: "delivered" | "rejected" | "expired" | "cancelled" | "failed",
    error?: string,
  ) {
    if (done.has(job.view.state)) return;
    job.view.state = state;
    job.view.error = error;
    if (state !== "delivered") {
      job.abort.abort();
      job.request?.destroy();
    }
    job.data = undefined;
    job.offer = undefined;
    job.directory = undefined;
    job.receipt = Date.now() + shareOfferLifetime;
    // Completion receipts have no content, file name, path, hash, or alias.
    job.view.name = "";
    job.view.peerName = "";
    job.view.bytes = 0;
    job.view.received = 0;
    job.view.destination = undefined;
    this.options.completed?.(
      state === "delivered"
        ? job.view.direction === "incoming"
          ? job.view.kind !== "markdown"
            ? job.view.kind === "message-file"
              ? "쪽지와 첨부 파일을 받았습니다."
              : "쪽지 파일을 다운로드 폴더에 저장했습니다."
            : "쪽지를 받았습니다."
          : "상대에게 전달했습니다."
        : error ||
            {
              rejected: "상대가 쪽지 요청을 거절했습니다.",
              expired: "쪽지 요청이 만료되었습니다.",
              cancelled: "쪽지 전송을 취소했습니다.",
              failed: "쪽지 전송에 실패했습니다.",
            }[state],
      state === "delivered" ? "info" : "error",
    );
    this.changed();
  }
  status(id: string) {
    const job = this.jobs.get(id);
    if (!job || (job.receipt !== undefined && job.receipt <= Date.now()))
      throw new Error("전송 기록이 없거나 정리되었습니다.");
    this.expire(job);
    return {
      id,
      state: job.view.state,
      ...(job.view.error ? { error: job.view.error } : {}),
    };
  }
  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("전송을 찾을 수 없습니다.");
    if (
      job.view.direction === "outgoing" &&
      this.identity &&
      this.enabled &&
      !done.has(job.view.state)
    )
      void shareRequest(
        this.identity,
        job.peer.endpoint,
        job.peer.cert,
        `/cancel/${id}`,
        Buffer.from("{}"),
      ).catch(() => {});
    this.finish(job, "cancelled");
  }
  control(input: ShareControlCommand, authorize: () => void = () => {}) {
    this.requireEnabled();
    authorize();
    switch (input.command) {
      case "share.inbox":
        for (const job of this.jobs.values()) this.expire(job);
        return {
          pending: [...this.jobs.values()]
            .filter(
              (job) =>
                job.view.direction === "incoming" && !done.has(job.view.state),
            )
            .map(({ view, deadline }) => ({
              id: view.id,
              peerId: view.peerId,
              peerName: view.peerName,
              state: view.state,
              kind: view.kind,
              name: view.name,
              bytes: view.bytes,
              created: view.created,
              expires: deadline,
            })),
          messages: this.store.messages(),
        };
      case "share.approve":
        return this.approve(input.id, true, () => {
          this.requireEnabled();
          authorize();
        }).then(() => this.status(input.id));
      case "share.read":
        return this.store.message(input.id);
      case "share.peers":
        return this.peers.map(({ id, name }) => ({
          id,
          name,
        }));
      case "share.send":
        return this.send(input.input);
      case "share.status":
        return this.status(input.id);
      case "share.cancel": {
        const job = this.jobs.get(input.id);
        if (!job || job.view.direction !== "outgoing")
          throw new Error("발신 전송만 취소할 수 있습니다.");
        this.cancel(input.id);
        return this.status(input.id);
      }
    }
  }
  private expire(job: Job) {
    if (!done.has(job.view.state) && Date.now() >= job.deadline)
      this.finish(job, "expired");
  }
  private sweep() {
    for (const [id, job] of this.jobs) {
      this.expire(job);
      if (job.receipt && Date.now() >= job.receipt) this.jobs.delete(id);
    }
    if (this.pairing && this.pairing.invite.expires <= Date.now()) {
      this.pairing = undefined;
      void this.pairListener?.close();
      this.pairListener = undefined;
      this.changed();
    }
    for (const [key, calls] of this.rates)
      if (calls.every((t) => Date.now() - t >= 60000)) this.rates.delete(key);
    let expiredNearby = false;
    for (const [id, peer] of this.nearby)
      if (Date.now() - peer.seen > 120000) {
        this.nearby.delete(id);
        expiredNearby = true;
      }
    if (expiredNearby) this.changed();
    if (this.bonjour && Date.now() >= this.nextDiscoveryQuery)
      this.refreshDiscovery();
    if (this.unlocked && this.store.prune()) this.changed();
    if (
      this.enabled &&
      !interfaces().some((i) => i.address === this.endpoint?.address)
    ) {
      this.error =
        "선택한 네트워크 연결이 끊겼습니다. 쪽지 설정을 다시 적용하세요.";
      void this.stop().then(() => this.changed());
    }
  }
  private startDiscovery(settings: ShareSettings) {
    try {
      const epoch = this.epoch;
      this.bonjour = createDiscovery(settings.address, () => {
        if (this.closed || epoch !== this.epoch) return;
        this.error =
          "주변 검색을 사용할 수 없습니다. 등록키와 IP로 연결해 주세요.";
        this.changed();
      });
      const instance = randomUUID();
      const advertised = this.bonjour.publish({
        name: instance,
        host: `${instance}.local`,
        type: "passport-share",
        port: this.endpoint!.port,
        txt: { label: settings.name },
        disableIPv6: true,
        probe: true,
      });
      // Bonjour's default records enumerate every NIC. Keep only the selected
      // IPv4 address; do not disclose the OS hostname or other network addresses.
      // With probing enabled records() is called asynchronously after publish.
      const records = advertised.records.bind(advertised);
      advertised.records = () =>
        records().filter(
          (record) =>
            record.type !== "AAAA" &&
            (record.type !== "A" || record.data === settings.address),
        );
      this.refreshDiscovery();
    } catch {
      this.error = "주변 검색을 시작할 수 없습니다.";
    }
  }
  private refreshDiscovery() {
    if (!this.bonjour) return;
    // Bonjour emits `up` only once for unchanged advertisements. A fresh
    // browser and query renew our bounded presence cache from actual replies,
    // without restarting the advertised service or the TLS listener.
    this.nextDiscoveryQuery = Date.now() + 60000;
    this.discoveryBrowser?.stop();
    const epoch = this.epoch;
    try {
      const up = (service: Bonjour.Service) => {
        if (this.closed || epoch !== this.epoch) return;
        const address = service.referer?.address;
        const key = `${address}:${service.port}`;
        if (
          !address ||
          !allowedAddress(address) ||
          (address === this.endpoint?.address &&
            service.port === this.endpoint?.port)
        )
          return;
        const parsed = shareLabel.safeParse(service.txt?.label);
        if (
          !parsed.success ||
          !Number.isInteger(service.port) ||
          service.port < 1 ||
          service.port > 65535
        )
          return;
        for (const [id, peer] of this.nearby)
          if (
            peer.instance === service.fqdn &&
            peer.endpoint.address === address &&
            id !== key
          )
            this.nearby.delete(id);
        if (this.nearby.size >= 100 && !this.nearby.has(key)) return;
        this.nearby.set(key, {
          name: parsed.data,
          endpoint: { address, port: service.port },
          seen: Date.now(),
          instance: service.fqdn,
        });
        this.changed();
      };
      const down: typeof up = (service) => {
        if (this.closed || epoch !== this.epoch) return;
        if (this.nearby.delete(`${service.referer?.address}:${service.port}`))
          this.changed();
      };
      this.discoveryBrowser = this.bonjour.find({ type: "passport-share" }, up);
      this.discoveryBrowser.on("down", down);
      this.discoveryBrowser.on("txt-update", up);
      this.discoveryBrowser.on("srv-update", (current, previous) => {
        down(previous);
        up(current);
      });
    } catch {
      this.error =
        "주변 검색을 사용할 수 없습니다. 등록키와 IP로 연결해 주세요.";
      this.changed();
    }
  }
  private async stop() {
    this.epoch++;
    this.endpoint = undefined;
    for (const join of this.joins) join.abort();
    this.joins.clear();
    for (const job of this.jobs.values()) this.finish(job, "cancelled");
    this.discoveryBrowser?.stop();
    this.discoveryBrowser = undefined;
    this.bonjour?.destroy();
    this.bonjour = undefined;
    this.nearby.clear();
    await this.pairListener?.close();
    this.pairListener = undefined;
    this.pairing = undefined;
    await this.listener?.close();
    this.listener = undefined;
    await Promise.allSettled([...this.tasks]);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.configuration.catch(() => {});
    await this.stop();
    this.store.close();
  }
}
