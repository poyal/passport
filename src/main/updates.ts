import { z } from "zod";
import { about } from "../shared/about";
import { initialUpdateState, type UpdateState } from "../shared/updates";

export const updateFeed =
  "https://api.github.com/repos/poyal/passport/releases/latest";
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const releaseSchema = z.object({
  tag_name: z.string().max(64),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z
    .array(
      z.object({
        name: z.string().max(256),
        state: z.string(),
        size: z.number().nonnegative(),
        browser_download_url: z.string().max(2048),
      }),
    )
    .max(100),
});

export function compareVersions(left: string, right: string) {
  if (!versionPattern.test(left) || !versionPattern.test(right))
    throw new Error("공개 버전 정보를 확인할 수 없습니다.");
  const a = left.split(".").map(Number),
    b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function releaseDetails(raw: unknown, platform: string, arch: string) {
  const release = releaseSchema.parse(raw);
  const version = release.tag_name.replace(/^v/, "");
  if (release.draft || release.prerelease || !versionPattern.test(version))
    throw new Error("정식 공개 버전 정보를 확인할 수 없습니다.");
  const base = about.links.releases;
  const name =
    platform === "darwin" && arch === "arm64"
      ? `Passport-${version}-mac-arm64.dmg`
      : platform === "win32" && arch === "x64"
        ? `Passport-${version}-win-x64.exe`
        : undefined;
  const expectedURL = name && `${base}/download/${release.tag_name}/${name}`;
  const installer = release.assets.find(
    (asset) =>
      asset.name === name &&
      asset.state === "uploaded" &&
      asset.size > 0 &&
      asset.browser_download_url === expectedURL,
  );
  return {
    version,
    releaseURL: `${base}/tag/${release.tag_name}`,
    downloadURL: installer ? expectedURL : undefined,
  };
}

type Options = {
  version: string;
  platform: string;
  arch: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  emit: (state: UpdateState) => void;
  now?: () => number;
  timeoutMs?: number;
};

export class UpdateChecker {
  state: UpdateState;
  private pending?: Promise<UpdateState>;
  private controller?: AbortController;
  private release?: ReturnType<typeof releaseDetails>;
  private started = false;
  private disposed = false;
  constructor(private options: Options) {
    this.state = initialUpdateState(options.version);
  }
  start(enabled: boolean) {
    if (!enabled || this.started || this.disposed) return;
    this.started = true;
    void this.check();
  }
  check(): Promise<UpdateState> {
    if (this.pending) return this.pending;
    const now = (this.options.now ?? Date.now)();
    if (
      this.disposed ||
      (this.state.checkedAt !== null && now - this.state.checkedAt < 5000)
    )
      return Promise.resolve(this.state);
    this.pending = this.run().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  target(kind: "download" | "release") {
    if (this.state.status !== "available" || !this.release)
      throw new Error("업데이트를 먼저 확인해 주세요.");
    const url =
      kind === "download" ? this.release.downloadURL : this.release.releaseURL;
    if (!url)
      throw new Error("이 기기의 설치 파일은 아직 게시되지 않았습니다.");
    return url;
  }
  dispose() {
    this.disposed = true;
    this.controller?.abort();
  }
  private set(state: UpdateState) {
    if (this.disposed) return;
    this.state = state;
    this.options.emit(state);
  }
  private async run() {
    this.release = undefined;
    this.set({
      ...this.state,
      status: "checking",
      latestVersion: null,
      installerAvailable: false,
      message: "새 버전을 확인하고 있습니다…",
    });
    const controller = (this.controller = new AbortController());
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 10_000,
    );
    timer.unref();
    try {
      const response = await this.options.fetch(updateFeed, {
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      });
      if (!response.ok) {
        if (response.status === 403 || response.status === 429)
          throw new Error(
            "GitHub의 요청 제한에 도달했습니다. 잠시 후 다시 확인해 주세요.",
          );
        if (response.status === 404)
          throw new Error(
            "공개 릴리즈를 찾을 수 없습니다. 잠시 후 다시 확인해 주세요.",
          );
        throw new Error(
          "GitHub에 연결할 수 없습니다. 잠시 후 다시 확인해 주세요.",
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("공개 버전 정보를 확인할 수 없습니다.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) {
            await reader.cancel();
            throw new Error("공개 버전 정보가 너무 큽니다.");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const release = releaseDetails(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
        this.options.platform,
        this.options.arch,
      );
      const comparison = compareVersions(release.version, this.options.version);
      this.release = release;
      this.set({
        currentVersion: this.options.version,
        latestVersion: release.version,
        status: comparison > 0 ? "available" : "current",
        installerAvailable: !!release.downloadURL,
        checkedAt: (this.options.now ?? Date.now)(),
        message:
          comparison > 0
            ? release.downloadURL
              ? `Passport ${release.version} 업데이트가 있습니다.`
              : `Passport ${release.version}이 공개되었습니다. 이 기기의 설치 파일은 아직 게시되지 않았습니다.`
            : comparison === 0
              ? "최신 버전을 사용하고 있습니다."
              : `현재 설치된 ${this.options.version}은 최신 공개 버전(${release.version})보다 새 버전입니다.`,
      });
    } catch (error) {
      this.set({
        ...initialUpdateState(this.options.version),
        status: "error",
        checkedAt: (this.options.now ?? Date.now)(),
        message: controller.signal.aborted
          ? "확인 시간이 초과되었습니다. 인터넷 연결을 확인하고 다시 시도해 주세요."
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? "공개 버전 정보를 확인할 수 없습니다."
            : error instanceof Error &&
                !/^Failed to fetch|^fetch failed|^net::/i.test(error.message)
              ? error.message
              : "업데이트를 확인하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.",
      });
    } finally {
      clearTimeout(timer);
      this.controller = undefined;
    }
    return this.state;
  }
}
