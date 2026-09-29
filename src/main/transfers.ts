import { PassThrough, Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import type { AppEvent, TransferJob } from "../shared/model";
import { Files, type FileAdapter } from "./files";

const safeName = (name: string) =>
  name !== "." && name !== ".." && !/[\/\\\r\n\0]/.test(name);
export function isWithin(parent: string, child: string, insensitive = false) {
  const clean = (v: string) => {
    const s = v.replace(/\\/g, "/").replace(/\/+$/, "");
    return insensitive ? s.toLowerCase() : s;
  };
  const p = clean(parent),
    c = clean(child);
  return c === p || c.startsWith(p + "/");
}
export class Transfers {
  jobs = new Map<string, TransferJob>();
  controllers = new Map<string, AbortController>();
  private active = 0;
  constructor(
    readonly files: Files,
    readonly emit: (event: AppEvent) => void,
  ) {}
  add(
    input: Pick<
      TransferJob,
      "source" | "destination" | "paths" | "target" | "conflict"
    >,
  ) {
    this.files.get(input.source);
    this.files.get(input.destination);
    const job: TransferJob = {
      ...input,
      id: randomUUID(),
      state: "queued",
      bytes: 0,
      total: 0,
      files: 0,
      skipped: 0,
      speed: 0,
    };
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, new AbortController());
    this.notify(job);
    void this.pump();
    return { ...job };
  }
  private notify(job: TransferJob) {
    this.emit({ kind: "transfer", job: { ...job } });
  }
  private async pump() {
    for (const job of this.jobs.values()) {
      if (this.active >= 3) break;
      if (job.state !== "queued") continue;
      this.active++;
      job.state = "running";
      this.notify(job);
      void this.run(job).finally(() => {
        this.active--;
        void this.pump();
      });
    }
  }
  private sameStorage(a: FileAdapter, b: FileAdapter) {
    if (a.endpoint.protocol === "local" || b.endpoint.protocol === "local")
      return a.endpoint.protocol === b.endpoint.protocol;
    const hosts = this.files.store.read().hosts,
      ah = hosts.find((h) => h.id === a.endpoint.hostId),
      bh = hosts.find((h) => h.id === b.endpoint.hostId);
    return (
      ah &&
      bh &&
      ah.address.toLowerCase() === bh.address.toLowerCase() &&
      (a.endpoint.protocol === "sftp") === (b.endpoint.protocol === "sftp") &&
      (ah.sftpPort ?? ah.port) === (bh.sftpPort ?? bh.port)
    );
  }
  private async run(job: TransferJob) {
    const controller = this.controllers.get(job.id)!,
      signal = controller.signal;
    let last = Date.now(),
      lastBytes = 0;
    let temp: string | undefined;
    let destination: FileAdapter | undefined;
    const check = () => {
      if (signal.aborted) throw new Error("전송을 취소했습니다.");
    };
    try {
      await this.files.locks.with([job.source, job.destination], async () => {
        check();
        const source = this.files.get(job.source);
        destination = this.files.get(job.destination);
        const dest = destination;
        if (
          source === dest &&
          (dest.endpoint.protocol === "ftp" ||
            dest.endpoint.protocol === "ftps")
        )
          throw new Error("FTP 복사는 좌우에 각각 연결해 주세요.");
        const target = await dest.realpath(dest.normalize(job.target));
        const targetStat = await dest.stat(target);
        if (targetStat?.kind !== "directory")
          throw new Error("대상 폴더를 찾을 수 없습니다.");
        const selected = job.paths.map((p) => source.normalize(p));
        // Collapse descendants of selected folders so each entry is copied once.
        const paths = selected.filter(
          (p, i) =>
            selected.indexOf(p) === i &&
            !selected.some((q, j) => i !== j && q !== p && isWithin(q, p)),
        );
        const copy = async (
          src: string,
          to: string,
          depth: number,
        ): Promise<void> => {
          check();
          if (depth > 128) throw new Error("폴더 깊이 제한을 초과했습니다.");
          const stat = await source.stat(src);
          if (!stat) throw new Error("원본 파일을 찾을 수 없습니다.");
          if (!safeName(stat.name))
            throw new Error(
              "경로 구분자가 포함된 파일 이름은 복사할 수 없습니다.",
            );
          if (stat.kind === "link") {
            job.skipped++;
            return;
          }
          const exists = await dest.stat(to);
          if (exists?.kind === "link")
            throw new Error("대상 심볼릭 링크에는 덮어쓸 수 없습니다.");
          if (exists && job.conflict === "skip") {
            job.skipped++;
            return;
          }
          if (exists && job.conflict === "rename") {
            let n = 1;
            const base = to;
            while (await dest.stat(to)) {
              check();
              to = `${base} (${n++})`;
            }
          }
          if (stat.kind === "directory") {
            if (
              exists &&
              job.conflict === "overwrite" &&
              exists.kind !== "directory"
            )
              throw new Error("파일과 폴더의 이름이 충돌합니다.");
            if (!(await dest.stat(to))) await dest.mkdir(to);
            const canonical = await dest.realpath(to);
            if (
              !isWithin(
                target,
                canonical,
                dest.endpoint.protocol === "local" &&
                  process.platform !== "linux",
              )
            )
              throw new Error("대상 경로가 전송 폴더 밖을 가리킵니다.");
            for (const child of await source.list(src)) {
              if (!safeName(child.name))
                throw new Error("올바르지 않은 원격 파일 이름입니다.");
              await copy(
                source.join(src, child.name),
                dest.join(to, child.name),
                depth + 1,
              );
            }
            return;
          }
          if (exists?.kind === "directory")
            throw new Error("대상 이름이 폴더와 충돌합니다.");
          job.total += stat.size;
          temp = dest.join(
            dest.parent(to),
            `.passport-${job.id}-${randomUUID()}.part`,
          );
          const bridge = new PassThrough({ highWaterMark: 64 * 1024 });
          const meter = new Transform({
            highWaterMark: 64 * 1024,
            transform: (chunk: Buffer, _encoding, callback) => {
              job.bytes += chunk.length;
              const now = Date.now();
              if (now - last > 200) {
                job.speed = ((job.bytes - lastBytes) * 1000) / (now - last);
                last = now;
                lastBytes = job.bytes;
                this.notify(job);
              }
              callback(null, chunk);
            },
          });
          // Either side failing closes both streams. allSettled waits for cleanup before releasing locks.
          bridge.on("error", () => {});
          meter.on("error", () => {});
          bridge.pipe(meter);
          const stop = () => {
            bridge.destroy(new Error("전송을 취소했습니다."));
            meter.destroy(new Error("전송을 취소했습니다."));
          };
          signal.addEventListener("abort", stop, { once: true });
          const guarded = (p: Promise<void>) =>
            p.catch((e) => {
              bridge.destroy(e);
              meter.destroy(e);
              throw e;
            });
          const result = await Promise.allSettled([
            guarded(source.download(src, bridge, signal)),
            guarded(dest.upload(temp, meter, signal)),
          ]);
          signal.removeEventListener("abort", stop);
          const failed = result.find(
            (r): r is PromiseRejectedResult => r.status === "rejected",
          );
          if (failed) throw failed.reason;
          check();
          const written = await dest.stat(temp);
          if (!written || written.size !== stat.size)
            throw new Error("전송 크기가 원본과 다릅니다.");
          const current = await dest.stat(to);
          if (current && job.conflict !== "overwrite")
            throw new Error(
              "전송 중 대상 이름이 생성되었습니다. 다시 시도해 주세요.",
            );
          if (current) {
            if (current.kind !== "file")
              throw new Error("대상 파일 종류가 변경되었습니다.");
            const backup = dest.join(
              dest.parent(to),
              `.passport-${randomUUID()}.backup`,
            );
            await dest.rename(to, backup);
            try {
              await dest.rename(temp, to);
              temp = undefined;
            } catch (e) {
              try {
                await dest.rename(backup, to);
              } catch {
                job.cleanup = `기존 파일 복원이 필요합니다: ${backup}`;
              }
              throw e;
            }
            try {
              await dest.remove(backup);
            } catch {
              job.cleanup = `기존 파일의 임시 백업이 남았습니다: ${backup}`;
            }
          } else {
            await dest.rename(temp, to);
            temp = undefined;
          }
          job.files++;
          this.notify(job);
        };
        for (const p of paths) {
          check();
          const stat = await source.stat(p);
          if (!stat) throw new Error("원본을 찾을 수 없습니다.");
          const to = dest.join(target, stat.name);
          if (this.sameStorage(source, dest)) {
            const canonical =
              stat.kind === "directory"
                ? await source.realpath(p)
                : source.join(
                    await source.realpath(source.parent(p)),
                    stat.name,
                  );
            if (
              isWithin(
                canonical,
                to,
                source.endpoint.protocol === "local" &&
                  process.platform !== "linux",
              )
            )
              throw new Error(
                "같은 경로 또는 원본 폴더의 하위로 복사할 수 없습니다.",
              );
          }
          await copy(p, to, 0);
        }
      });
      job.state = "completed";
    } catch (error) {
      job.state = signal.aborted ? "cancelled" : "error";
      job.error =
        error instanceof Error ? error.message : "파일 전송에 실패했습니다.";
    } finally {
      if (temp && destination) {
        try {
          await this.files.locks.with([job.destination], () =>
            destination!.remove(temp!),
          );
          job.cleanup = job.cleanup ?? "임시 파일을 정리했습니다.";
        } catch {
          job.cleanup = `임시 파일을 수동으로 정리해 주세요: ${temp}`;
        }
      }
      job.speed = 0;
      this.notify(job);
      this.controllers.delete(job.id);
    }
  }
  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.controllers.get(id)?.abort();
    if (job.state === "queued") {
      job.state = "cancelled";
      this.controllers.delete(id);
      this.notify(job);
    }
  }
  retry(id: string) {
    const job = this.jobs.get(id);
    if (!job || !["error", "cancelled"].includes(job.state))
      throw new Error("실패 또는 취소된 전송만 재시도할 수 있습니다.");
    return this.add({
      source: job.source,
      destination: job.destination,
      paths: job.paths,
      target: job.target,
      conflict: job.conflict,
    });
  }
  cancelAll() {
    for (const id of this.jobs.keys()) this.cancel(id);
  }
  rebind(previousId: string, nextId: string) {
    for (const job of this.jobs.values())
      if (["error", "cancelled"].includes(job.state)) {
        if (job.source === previousId) job.source = nextId;
        if (job.destination === previousId) job.destination = nextId;
        this.notify(job);
      }
  }
  busy(id: string) {
    return [...this.jobs.values()].some(
      (j) =>
        (j.source === id || j.destination === id) &&
        ["queued", "running"].includes(j.state),
    );
  }
}
