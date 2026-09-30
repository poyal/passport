import { describe, it, expect, vi } from "vitest";
import {
  UpdateChecker,
  compareVersions,
  releaseDetails,
  updateFeed,
} from "../src/main/updates";

const release = (version = "1.0.2", platform = "mac", arch = "arm64") => {
  const name = `Passport-${version}-${platform}-${arch}.${platform === "mac" ? "dmg" : "exe"}`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name,
        state: "uploaded",
        size: 1024,
        browser_download_url: `https://github.com/poyal/passport/releases/download/v${version}/${name}`,
      },
    ],
  };
};
const fixture = (fetcher = vi.fn(async () => Response.json(release()))) => {
  let now = 10000;
  const states: unknown[] = [];
  const checker = new UpdateChecker({
    version: "1.0.1",
    platform: "darwin",
    arch: "arm64",
    fetch: fetcher,
    emit: (state) => states.push(state),
    now: () => now,
  });
  return {
    checker,
    fetcher,
    states,
    advance: () => {
      now += 6000;
    },
  };
};

describe("GitHub release checks", () => {
  it("orders numeric stable versions and rejects prerelease or malformed tags", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.0.1", "1.0.1")).toBe(0);
    for (const tag_name of [
      "v1.0.2-beta.1",
      "v01.0.2",
      "../x",
      "v1.0.2/other",
    ]) {
      expect(() =>
        releaseDetails({ ...release(), tag_name }, "darwin", "arm64"),
      ).toThrow();
    }
    expect(() =>
      releaseDetails({ ...release(), draft: true }, "darwin", "arm64"),
    ).toThrow();
    expect(() =>
      releaseDetails({ ...release(), prerelease: true }, "darwin", "arm64"),
    ).toThrow();
  });
  it("selects only an uploaded installer for the exact platform, architecture, and repository", () => {
    expect(releaseDetails(release(), "darwin", "arm64").downloadURL).toMatch(
      /mac-arm64\.dmg$/,
    );
    expect(
      releaseDetails(release("1.0.2", "win", "x64"), "win32", "x64")
        .downloadURL,
    ).toMatch(/win-x64\.exe$/);
    expect(
      releaseDetails(release("1.0.2", "win", "arm64"), "win32", "arm64")
        .downloadURL,
    ).toMatch(/win-arm64\.exe$/);
    for (const browser_download_url of [
      "https://evil.test/app.dmg",
      "file:///tmp/app.dmg",
      "https://github.com/other/app/releases/download/v1.0.2/Passport-1.0.2-mac-arm64.dmg",
    ]) {
      const raw = release();
      raw.assets[0].browser_download_url = browser_download_url;
      expect(
        releaseDetails(raw, "darwin", "arm64").downloadURL,
      ).toBeUndefined();
    }
    expect(
      releaseDetails(release(), "win32", "x64").downloadURL,
    ).toBeUndefined();
    expect(
      releaseDetails(release(), "darwin", "x64").downloadURL,
    ).toBeUndefined();
    const uploading = release();
    uploading.assets[0].state = "new";
    expect(
      releaseDetails(uploading, "darwin", "arm64").downloadURL,
    ).toBeUndefined();
  });
  it("checks once at startup, deduplicates in-flight clicks, and opens only validated release URLs", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const { checker, states } = fixture(fetcher);
    checker.start(false);
    expect(fetcher).not.toHaveBeenCalled();
    checker.start(true);
    checker.start(true);
    const first = checker.check(),
      second = checker.check();
    expect(first).toBe(second);
    expect(checker.state.status).toBe("checking");
    resolve(Response.json(release()));
    expect((await first).status).toBe("available");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      updateFeed,
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    ]);
    expect(checker.target("download")).toMatch(
      /^https:\/\/github.com\/poyal\/passport\/releases\/download\/v1.0.2\/Passport-/,
    );
    expect(checker.target("release")).toBe(
      "https://github.com/poyal/passport/releases/tag/v1.0.2",
    );
    expect(states).toHaveLength(2);
    await checker.check();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not offer downgrades and distinguishes equal versions from ahead-of-release builds", async () => {
    for (const version of ["1.0.0", "1.0.1"]) {
      const { checker } = fixture(
        vi.fn(async () => Response.json(release(version))),
      );
      const state = await checker.check();
      expect(state.status).toBe("current");
      expect(state.message).toContain(
        version === "1.0.0" ? "보다 새 버전" : "최신 버전",
      );
      expect(() => checker.target("download")).toThrow();
    }
  });
  it("keeps release notes available when this machine has no published installer", async () => {
    const { checker } = fixture(
      vi.fn(async () => Response.json({ ...release(), assets: [] })),
    );
    const state = await checker.check();
    expect(state.status).toBe("available");
    expect(state.installerAvailable).toBe(false);
    expect(state.message).toContain("아직 게시되지 않았습니다");
    expect(() => checker.target("download")).toThrow();
    expect(checker.target("release")).toContain("/tag/v1.0.2");
  });
  it("handles rate limits, no releases, malformed responses, offline errors, and a subsequent successful retry", async () => {
    for (const response of [
      new Response("", { status: 403 }),
      new Response("", { status: 404 }),
      new Response("", { status: 503 }),
      Response.json({ bad: true }),
      new Response("invalid json"),
    ]) {
      const fetcher = vi.fn(async () => response);
      const { checker, advance } = fixture(fetcher);
      expect((await checker.check()).status).toBe("error");
      expect(() => checker.target("release")).toThrow();
      advance();
      fetcher.mockImplementation(async () => Response.json(release()));
      expect((await checker.check()).status).toBe("available");
    }
    const { checker } = fixture(
      vi.fn(async () => {
        throw new Error("net::ERR_INTERNET_DISCONNECTED");
      }),
    );
    expect((await checker.check()).message).toContain("인터넷 연결");
  });
  it("invalidates a previous download when a new check fails, and bounds response size", async () => {
    const { checker, fetcher, advance } = fixture();
    await checker.check();
    advance();
    fetcher.mockImplementation(
      async () => new Response("x".repeat(1024 * 1024 + 1)),
    );
    expect((await checker.check()).message).toContain("너무 큽니다");
    expect(() => checker.target("download")).toThrow();
  });
  it("times out requests and cancels startup work without publishing events after disposal", async () => {
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const timeout = new UpdateChecker({
      version: "1.0.1",
      platform: "darwin",
      arch: "arm64",
      fetch: fetcher,
      emit: () => {},
      timeoutMs: 20,
    });
    expect((await timeout.check()).message).toContain("시간이 초과");
    const emit = vi.fn();
    const cancel = new UpdateChecker({
      version: "1.0.1",
      platform: "darwin",
      arch: "arm64",
      fetch: fetcher,
      emit,
    });
    const pending = cancel.check();
    cancel.dispose();
    await pending;
    expect(emit).toHaveBeenCalledTimes(1);
    await cancel.check();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
