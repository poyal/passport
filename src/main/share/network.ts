import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import {
  createSecureContext,
  type SecureContext,
  type TLSSocket,
} from "node:tls";
import { constants } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  fingerprint,
  validateCertificate,
  type ShareIdentity,
} from "./identity";
import type { ShareEndpoint } from "../../shared/share";

export function interfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((a) => a.family === "IPv4" && allowedAddress(a.address))
      .map((a) => ({ name, address: a.address })),
  );
}
export function allowedAddress(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
export function validateEndpoint(endpoint: ShareEndpoint) {
  if (
    !allowedAddress(endpoint.address) ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  )
    throw new Error("같은 LAN의 IPv4 주소와 올바른 포트를 입력하세요.");
}
export function remoteCertificate(socket: TLSSocket) {
  const raw = socket.getPeerCertificate()?.raw;
  if (!raw || socket.isSessionReused())
    throw new Error("기기 인증서가 필요합니다.");
  const cert = validateCertificate(raw);
  return { id: fingerprint(raw), cert: cert.toString() };
}
export async function readJSON(
  message: IncomingMessage,
  limit = 32768,
): Promise<unknown> {
  if (
    message.headers["content-encoding"] ||
    message.headers["content-type"] !== "application/json"
  )
    throw new Error("지원하지 않는 요청 형식입니다.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of message) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("요청 크기를 초과했습니다.");
    chunks.push(chunk);
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}
export function json(response: ServerResponse, value: unknown, status = 200) {
  if (!response.destroyed)
    response
      .writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        connection: "close",
      })
      .end(JSON.stringify(value));
}
export class ShareListener {
  readonly server: https.Server;
  private sockets = new Set<Socket>();
  private peerContexts = new Map<string, SecureContext>();
  constructor(
    identity: ShareIdentity,
    peers: string[],
    pairing: boolean,
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
      identity: { id: string; cert: string },
    ) => Promise<void>,
  ) {
    this.updatePeerContexts(identity, peers);
    this.server = https.createServer(
      {
        ...identity,
        ca: peers.length ? peers : [identity.cert],
        requestCert: true,
        // Bootstrap only: a one-time invitation authenticates the newly presented
        // client certificate. TLS still verifies CertificateVerify possession.
        // This listener has no message/file routes. The regular listener ALWAYS
        // requires CA validation in addition to the application's exact pin check.
        rejectUnauthorized: !pairing,
        // Every legacy device certificate has the same subject. OpenSSL can
        // select the wrong issuer from a combined CA list. SNI selects one
        // registered pin; TLS must still prove possession and validate it.
        SNICallback: (name, callback) => {
          if (pairing || name === "passport-share") return callback(null);
          const context = this.peerContexts.get(name);
          if (!context) return callback(new Error("등록되지 않은 기기입니다."));
          callback(null, context);
        },
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        secureOptions: constants.SSL_OP_NO_TICKET,
        handshakeTimeout: 5000,
        maxHeaderSize: 8192,
      },
      (req, res) => {
        void (async () => {
          const socket = req.socket as TLSSocket;
          if (
            (!pairing && !socket.authorized) ||
            req.method !== "POST" ||
            req.headers.origin
          )
            throw new Error("허용되지 않은 요청입니다.");
          const peer = remoteCertificate(socket);
          await handler(req, res, peer);
        })().catch(() => {
          json(res, { error: "요청을 처리할 수 없습니다." }, 403);
          req.resume();
        });
      },
    );
    this.server.maxConnections = 32;
    this.server.headersTimeout = 5000;
    this.server.requestTimeout = 120000;
    this.server.keepAliveTimeout = 1000;
    this.server.on("connection", (socket) => {
      if (
        [...this.sockets].filter(
          (s) => s.remoteAddress === socket.remoteAddress,
        ).length >= 4
      ) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.setTimeout(30000, () => socket.destroy());
      socket.on("error", () => {});
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("tlsClientError", () => {});
    this.server.on("clientError", (_, socket) => socket.destroy());
  }
  async listen(address: string, port = 0): Promise<ShareEndpoint> {
    if (!allowedAddress(address))
      throw new Error("허용되지 않은 수신 주소입니다.");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, address, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    this.server.on("error", () => this.disconnect());
    const addressInfo = this.server.address();
    if (!addressInfo || typeof addressInfo === "string")
      throw new Error("쪽지 서버를 열 수 없습니다.");
    return { address, port: addressInfo.port };
  }
  trust(identity: ShareIdentity, peers: string[]) {
    this.updatePeerContexts(identity, peers);
    this.server.setSecureContext({
      ...identity,
      ca: peers.length ? peers : [identity.cert],
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      secureOptions: constants.SSL_OP_NO_TICKET,
    });
  }
  private updatePeerContexts(identity: ShareIdentity, peers: string[]) {
    this.peerContexts = new Map(
      peers.map((cert) => [
        clientServerName(cert),
        createSecureContext({
          ...identity,
          ca: [cert],
          minVersion: "TLSv1.3",
          maxVersion: "TLSv1.3",
          secureOptions: constants.SSL_OP_NO_TICKET,
        }),
      ]),
    );
  }
  disconnect() {
    for (const socket of this.sockets) socket.destroy();
  }
  async close() {
    this.disconnect();
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function clientServerName(cert: string) {
  const id = fingerprint(cert);
  return `${id.slice(0, 32)}.${id.slice(32)}.passport-share`;
}

export async function shareRequest(
  identity: ShareIdentity,
  endpoint: ShareEndpoint,
  cert: string,
  route: string,
  body: Buffer,
  signal?: AbortSignal,
  binary = false,
): Promise<unknown> {
  validateEndpoint(endpoint);
  validateCertificate(cert);
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        ...identity,
        ca: [cert],
        hostname: endpoint.address,
        port: endpoint.port,
        servername: clientServerName(identity.cert),
        path: route,
        method: "POST",
        agent: false,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        signal,
        checkServerIdentity: (_, peer) =>
          peer.raw && fingerprint(peer.raw) === fingerprint(cert)
            ? undefined
            : new Error("상대 기기 인증서가 변경되었습니다."),
        headers: {
          "content-type": binary
            ? "application/octet-stream"
            : "application/json",
          "content-length": body.length,
        },
      },
      (response) => {
        void (async () => {
          const value = await readJSON(response);
          if (response.statusCode !== 200)
            throw new Error("상대 기기가 요청을 거절했습니다.");
          resolve(value);
        })().catch((error) => {
          request.destroy();
          reject(error);
        });
      },
    );
    const timeout = () =>
      request.destroy(new Error("쪽지 연결이 시간 초과되었습니다."));
    // Socket idle time alone lets a peer keep a request alive indefinitely by
    // trickling bytes. Bound the full TLS/connect/upload/response operation too.
    const deadline = setTimeout(timeout, binary ? 120000 : 30000);
    deadline.unref();
    request.once("close", () => clearTimeout(deadline));
    request.setTimeout(30000, timeout);
    request.on("error", reject);
    request.end(body);
  });
}
