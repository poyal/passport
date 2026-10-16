import "reflect-metadata";
import {
  X509Certificate,
  randomBytes,
  webcrypto,
  timingSafeEqual,
} from "node:crypto";
import * as x509 from "@peculiar/x509";
import { z } from "zod";
import { shareEndpointSchema, shareInviteLifetime } from "../../shared/share";

export type ShareIdentity = { cert: string; key: string };
export const identitySchema = z
  .object({ cert: z.string().max(8192), key: z.string().max(8192) })
  .strict();
export function fingerprint(cert: string | Buffer) {
  return new X509Certificate(cert).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
}
export function validateCertificate(cert: string | Buffer) {
  const parsed = new X509Certificate(cert);
  if (
    parsed.raw.length > 4096 ||
    !parsed.verify(parsed.publicKey) ||
    parsed.ca ||
    parsed.publicKey.asymmetricKeyType !== "ec" ||
    parsed.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
    Date.parse(parsed.validFrom) > Date.now() ||
    Date.parse(parsed.validTo) <= Date.now() ||
    parsed.checkHost("passport-share") !== "passport-share"
  )
    throw new Error("유효하지 않은 공유 기기 인증서입니다.");
  return parsed;
}
export async function createIdentity(): Promise<ShareIdentity> {
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = await webcrypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: randomBytes(16).toString("hex"),
      name: "CN=passport-share",
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 365 * 86400000),
      signingAlgorithm: algorithm,
      keys: keys as unknown as CryptoKeyPair,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.ExtendedKeyUsageExtension([
          "1.3.6.1.5.5.7.3.1",
          "1.3.6.1.5.5.7.3.2",
        ]),
        new x509.SubjectAlternativeNameExtension([
          { type: "dns", value: "passport-share" },
        ]),
      ],
    },
    webcrypto as unknown as Crypto,
  );
  const der = Buffer.from(
    await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
  );
  const key = `-----BEGIN PRIVATE KEY-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END PRIVATE KEY-----`;
  validateCertificate(cert.toString("pem"));
  return { cert: cert.toString("pem"), key };
}
export const inviteSchema = z
  .object({
    version: z.literal(1),
    endpoint: shareEndpointSchema,
    cert: z.string().max(8192),
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    expires: z.number().int(),
  })
  .strict();
export type ShareInvite = z.infer<typeof inviteSchema>;
export function encodeInvite(invite: ShareInvite) {
  return (
    "passport-pair:" + Buffer.from(JSON.stringify(invite)).toString("base64url")
  );
}
export function decodeInvite(value: string): ShareInvite {
  if (!value.startsWith("passport-pair:") || value.length > 16000)
    throw new Error("등록키 형식이 올바르지 않습니다.");
  const invite = inviteSchema.parse(
    JSON.parse(Buffer.from(value.slice(14), "base64url").toString("utf8")),
  );
  validateCertificate(invite.cert);
  if (
    invite.expires <= Date.now() ||
    invite.expires > Date.now() + shareInviteLifetime + 60000
  )
    throw new Error("등록키가 만료되었거나 시간이 올바르지 않습니다.");
  return invite;
}
export function sameSecret(a: string, b: string) {
  return (
    /^[a-f0-9]{64}$/.test(a) &&
    /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  );
}
