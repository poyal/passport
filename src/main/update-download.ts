import { randomUUID } from "node:crypto";
import { mkdir, writeFile, open, rm } from "node:fs/promises";
import path from "node:path";
import {
  verifyUpdateManifest,
  verifyUpdatePackage,
  updateAssetURL,
  type UpdateTarget,
} from "./update-protocol";

export type PreparedUpdate = { directory: string; version: string };
type Options = {
  directory: string;
  publicKey: string;
  current: string;
  target: UpdateTarget;
  fetch: typeof fetch;
  progress: (received: number, total: number) => void;
};
/** One isolated transaction per download. Failed/aborted files are never ready. */
export class UpdateDownload {
  private controller?: AbortController;
  ready?: PreparedUpdate;
  constructor(private options: Options) {}
  cancel() {
    this.controller?.abort();
  }
  async download(version: string): Promise<PreparedUpdate> {
    if (this.controller) throw new Error("이미 다운로드 중입니다.");
    if (!/^\d+\.\d+\.\d+$/.test(version))
      throw new Error("잘못된 업데이트 버전입니다.");
    const controller = (this.controller = new AbortController());
    this.ready = undefined;
    const directory = path.join(this.options.directory, randomUUID());
    const get = async (url: string, limit: number, output?: string) => {
      // A stalled response must also time out after headers arrive.
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15 * 60_000),
      ]);
      const response = await this.options.fetch(url, {
        signal,
        credentials: "omit",
        redirect: "follow",
      });
      if (!response.ok || !response.body)
        throw new Error("업데이트 파일을 다운로드하지 못했습니다.");
      const final = new URL(response.url || url);
      if (
        final.protocol !== "https:" ||
        ![
          "github.com",
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
        ].includes(final.hostname)
      )
        throw new Error("허용되지 않은 다운로드 위치입니다.");
      let count = 0;
      const chunks: Uint8Array[] = [];
      const file = output ? await open(output, "wx", 0o600) : undefined;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          count += value.byteLength;
          if (count > limit)
            throw new Error("업데이트 파일 크기를 초과했습니다.");
          if (file) {
            await file.writeFile(value);
            this.options.progress(count, limit);
          } else chunks.push(value);
        }
        await file?.sync();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await file?.close();
      }
      return Buffer.concat(chunks);
    };
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const base = `https://github.com/poyal/passport/releases/download/v${version}`;
      const bytes = await get(
        `${base}/update-${this.options.target}.json`,
        65536,
      );
      const signature = await get(
        `${base}/update-${this.options.target}.sig`,
        64,
      );
      const manifest = verifyUpdateManifest(
        bytes,
        signature,
        this.options.publicKey,
        this.options.current,
        version,
      );
      const asset = manifest.platforms[this.options.target];
      if (!asset)
        throw new Error("이 기기의 업데이트 파일은 아직 게시되지 않았습니다.");
      await get(
        updateAssetURL(manifest, this.options.target),
        asset.size,
        path.join(directory, "package.zip"),
      );
      controller.signal.throwIfAborted();
      await verifyUpdatePackage(path.join(directory, "package.zip"), asset);
      await writeFile(path.join(directory, "update.json"), bytes, {
        mode: 0o600,
      });
      await writeFile(path.join(directory, "update.sig"), signature, {
        mode: 0o600,
      });
      controller.signal.throwIfAborted();
      return (this.ready = { directory, version });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      this.controller = undefined;
    }
  }
}
