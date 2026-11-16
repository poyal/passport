import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { compareVersions } from "./updates";

const version = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
const asset = z
  .object({
    name: z.string().max(128),
    size: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 ** 3),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const schema = z
  .object({
    format: z.literal("passport-update-v1"),
    version,
    platforms: z
      .object({
        "darwin-arm64": asset.optional(),
        "win32-x64": asset.optional(),
      })
      .strict(),
  })
  .strict();
export type UpdateManifest = z.infer<typeof schema>;
export type UpdateAsset = z.infer<typeof asset>;
export type UpdateTarget = keyof UpdateManifest["platforms"];

/** Authenticate the original bytes before interpreting any attacker-controlled JSON. */
export function verifyUpdateManifest(
  bytes: Buffer,
  signature: Buffer,
  publicKey: string,
  current: string,
  expected: string,
) {
  if (bytes.length > 64 * 1024 || signature.length !== 64)
    throw new Error("업데이트 메타데이터가 올바르지 않습니다.");
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, bytes, key, signature)
  )
    throw new Error("업데이트 서명을 확인할 수 없습니다.");
  const manifest = schema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    manifest.version !== expected ||
    compareVersions(manifest.version, current) <= 0
  )
    throw new Error("업데이트 버전이 일치하지 않거나 이전 버전입니다.");
  for (const [target, item] of Object.entries(manifest.platforms)) {
    if (item.name !== `Passport-${manifest.version}-${target}-update.zip`)
      throw new Error("업데이트 파일 이름이 올바르지 않습니다.");
  }
  return manifest;
}

export function updateAssetURL(manifest: UpdateManifest, target: UpdateTarget) {
  const item = manifest.platforms[target];
  if (!item)
    throw new Error("이 기기의 업데이트 파일은 아직 게시되지 않았습니다.");
  return `https://github.com/poyal/passport/releases/download/v${manifest.version}/${item.name}`;
}

export async function verifyUpdatePackage(file: string, expected: UpdateAsset) {
  const info = await stat(file);
  if (!info.isFile() || info.size !== expected.size)
    throw new Error("업데이트 파일 크기가 일치하지 않습니다.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== expected.sha256)
    throw new Error("업데이트 파일이 손상되었습니다.");
}
