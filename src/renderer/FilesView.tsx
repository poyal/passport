import {
  defaultShortcuts,
  shortcutMatch,
  shortcutPlatform,
} from "../shared/shortcuts";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowLeftRight,
  RefreshCw,
  FolderPlus,
  FilePlus,
  Folder,
  File,
  Link as LinkIcon,
  Search,
  MoreHorizontal,
  Trash2,
  Copy,
  Edit3,
  Shield,
  HardDrive,
  Server,
  X,
  RotateCcw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { Endpoint, FileEntry, TransferJob } from "../shared/model";
import { useApp } from "./context";
import { api } from "./api";
import { HostIcon } from "./HostIcon";
import { HostPicker } from "./HostPicker";
import { IconButton, Empty, sizeLabel } from "./components";
const fileMime = "application/x-passport-files";
type Snapshot = {
  endpoint: Endpoint | null;
  path: string;
  selected: FileEntry[];
};
const parentPath = (p: string) => {
  const parts = p.replace(/[\\/]$/, "").split(/[\\/]/);
  parts.pop();
  return parts.length
    ? (parts.join(p.includes("\\") ? "\\" : "/") || "/") +
        (parts.length === 1 && /^[A-Z]:$/i.test(parts[0]) ? "\\" : "")
    : p.startsWith("/")
      ? "/"
      : p;
};
export function FilesView() {
  const app = useApp(),
    [snapshots, setSnapshots] = useState<Snapshot[]>([
      { endpoint: null, path: "", selected: [] },
      { endpoint: null, path: "", selected: [] },
    ]),
    [conflict, setConflict] = useState<TransferJob["conflict"]>("skip"),
    [collapsed, setCollapsed] = useState(false);
  const copy = async (side: number, paths?: string[], sourceId?: string) => {
    const from = snapshots[side],
      to = snapshots[1 - side];
    if (!to.endpoint || !from.endpoint) {
      app.notify("좌우 패널을 먼저 연결해 주세요.");
      return;
    }
    const selected = paths ?? from.selected.map((f) => f.path);
    if (!selected.length) {
      app.notify("복사할 항목을 선택해 주세요.");
      return;
    }
    try {
      await api.call("transfer.add", {
        source: sourceId ?? from.endpoint.id,
        destination: to.endpoint.id,
        paths: selected,
        target: to.path,
        conflict,
      });
    } catch (e) {
      app.notify(e);
    }
  };
  const finished = app.jobs
    .filter((j) => j.state === "completed")
    .map((j) => j.id)
    .join(",");
  return (
    <div className="files-view">
      <div className="files-toolbar">
        <div className="row">
          <ArrowLeftRight size={19} />
          <h2>파일 전송</h2>
          <span className="muted">서로 다른 서버도, 같은 화면에서.</span>
        </div>
        <div className="row">
          <label className="inline-label">
            같은 이름
            <select
              aria-label="파일 충돌 처리"
              value={conflict}
              onChange={(e) => setConflict(e.target.value as typeof conflict)}
            >
              <option value="skip">건너뛰기</option>
              <option value="overwrite">덮어쓰기</option>
              <option value="rename">이름 변경</option>
            </select>
          </label>
          <button onClick={() => void copy(0)}>왼쪽 → 오른쪽</button>
          <button onClick={() => void copy(1)}>왼쪽 ← 오른쪽</button>
        </div>
      </div>
      <div className="file-panels">
        {[0, 1].map((side) => (
          <FilePanel
            key={side}
            side={side}
            other={snapshots[1 - side]}
            onSnapshot={(state) =>
              setSnapshots((prev) =>
                prev.map((s, i) => (i === side ? state : s)),
              )
            }
            onCopy={(paths, source) => void copy(side, paths, source)}
            onDropFiles={(paths, source) => void copy(1 - side, paths, source)}
            completed={finished}
          />
        ))}
      </div>
      <div className={`transfer-queue ${collapsed ? "collapsed" : ""}`}>
        <header onDoubleClick={() => setCollapsed(!collapsed)}>
          <div className="row">
            <ArrowLeftRight size={14} />
            <strong>전송 대기열</strong>
            <span className="pill">
              {
                app.jobs.filter((j) => ["queued", "running"].includes(j.state))
                  .length
              }
              개 진행 중
            </span>
            <span className="muted">동시 전송 최대 3개</span>
          </div>
          <IconButton
            label={collapsed ? "전송 목록 펼치기" : "전송 목록 접기"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </IconButton>
        </header>
        {!collapsed && (
          <div className="transfer-list">
            {app.jobs.length ? (
              app.jobs
                .slice()
                .reverse()
                .map((job) => (
                  <div key={job.id} className={`transfer-row ${job.state}`}>
                    <div className="transfer-icon">
                      <File size={17} />
                    </div>
                    <div className="transfer-info">
                      <strong>
                        {job.paths.length === 1
                          ? job.paths[0].split(/[\\/]/).pop()
                          : `${job.paths.length}개 항목`}{" "}
                        <span className="muted">→ {job.target}</span>
                      </strong>
                      <div className="progress-track">
                        <div
                          style={{
                            width:
                              job.state === "completed"
                                ? "100%"
                                : `${Math.min(99, job.total ? (job.bytes / job.total) * 100 : 0)}%`,
                          }}
                        />
                      </div>
                      <small>
                        {
                          {
                            queued: "대기 중",
                            running: "전송 중",
                            completed: "완료",
                            cancelled: "취소됨",
                            error: "실패",
                          }[job.state]
                        }{" "}
                        · {sizeLabel(job.bytes)}
                        {job.total ? ` / ${sizeLabel(job.total)}` : ""} ·{" "}
                        {job.files}개 완료
                        {job.skipped ? ` · ${job.skipped}개 건너뜀` : ""}
                        {job.speed ? ` · ${sizeLabel(job.speed)}/s` : ""}
                        {job.error ? ` · ${job.error}` : ""}
                        {job.cleanup ? ` · ${job.cleanup}` : ""}
                      </small>
                    </div>
                    {["queued", "running"].includes(job.state) ? (
                      <IconButton
                        label="전송 취소"
                        onClick={() =>
                          void api
                            .call("transfer.cancel", { id: job.id })
                            .catch(app.notify)
                        }
                      >
                        <X size={15} />
                      </IconButton>
                    ) : ["error", "cancelled"].includes(job.state) ? (
                      <IconButton
                        label="전송 재시도"
                        onClick={() =>
                          void api
                            .call("transfer.retry", { id: job.id })
                            .catch(app.notify)
                        }
                      >
                        <RotateCcw size={15} />
                      </IconButton>
                    ) : null}
                  </div>
                ))
            ) : (
              <div className="queue-empty">
                파일을 반대편으로 드래그하거나 복사 버튼을 눌러 전송하세요.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
function FilePanel({
  side,
  other,
  onSnapshot,
  onCopy,
  onDropFiles,
  completed,
}: {
  side: number;
  other: Snapshot;
  onSnapshot: (s: Snapshot) => void;
  onCopy: (paths?: string[], source?: string) => void;
  onDropFiles: (paths: string[], source: string) => void;
  completed: string;
}) {
  const app = useApp(),
    [endpoint, setEndpoint] = useState<Endpoint | null>(null),
    [path, setPath] = useState(""),
    [pathInput, setPathInput] = useState(""),
    [entries, setEntries] = useState<FileEntry[]>([]),
    [selection, setSelection] = useState<string[]>([]),
    [filter, setFilter] = useState(""),
    [hidden, setHidden] = useState(true),
    [sort, setSort] = useState<{
      key: "name" | "size" | "modified" | "kind";
      reverse: boolean;
    }>({ key: "name", reverse: false }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [choosingHost, setChoosingHost] = useState(false),
    [hostId, setHostId] = useState("local"),
    [menu, setMenu] = useState<{
      x: number;
      y: number;
      paths: string[];
      toolbar: boolean;
    } | null>(null),
    [drop, setDrop] = useState(false),
    [history, setHistory] = useState<string[]>([]),
    [position, setPosition] = useState(-1);
  const endpointRef = useRef<Endpoint | null>(null),
    generation = useRef(0),
    anchor = useRef(0),
    menuRef = useRef<HTMLDivElement>(null),
    menuButtonRef = useRef<HTMLButtonElement>(null),
    lastRequest = useRef(0);
  const selected = entries.filter((f) => selection.includes(f.path));
  useEffect(() => {
    onSnapshot({ endpoint, path, selected });
  }, [endpoint, path, entries, selection]);
  const navigate = async (
    p: string,
    record = true,
    ep = endpointRef.current,
  ) => {
    if (!ep) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setMenu(null);
    try {
      const result = await api.call("files.list", { id: ep.id, path: p });
      if (request !== generation.current) return;
      setPath(result.path);
      setPathInput(result.path);
      setEntries(result.entries);
      setSelection([]);
      if (record) {
        setHistory((h) => [...h.slice(0, position + 1), result.path]);
        setPosition(position + 1);
      }
    } catch (e) {
      if (request === generation.current) {
        setError(e instanceof Error ? e.message : "폴더를 열 수 없습니다.");
        app.notify(e);
      }
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  const connect = async (id: string) => {
    setBusy(true);
    setError("");
    setMenu(null);
    let next: Endpoint | null = null;
    try {
      const host = app.document.hosts.find((h) => h.id === id);
      const secret = host ? await app.credentials(host, true) : undefined;
      if (secret === null) {
        setBusy(false);
        return;
      }
      next = await api.call("files.connect", {
        hostId: host?.id ?? null,
        secret,
        previousId: endpointRef.current?.id,
      });
      endpointRef.current = next;
      setEndpoint(next);
      setHostId(host?.id ?? "local");
      setHistory([next.initialPath]);
      setPosition(0);
      await navigate(next.initialPath, false, next);
    } catch (e) {
      if (next && next !== endpointRef.current)
        void api.call("files.close", { id: next.id }).catch(() => {});
      setError(e instanceof Error ? e.message : "파일 연결에 실패했습니다.");
      app.notify(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void connect("local");
    return () => {
      generation.current++;
      const ep = endpointRef.current;
      if (ep) void api.call("files.close", { id: ep.id }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    const r = app.fileRequest;
    if (r && r.side === side && r.nonce !== lastRequest.current) {
      lastRequest.current = r.nonce;
      void connect(r.hostId);
    }
  }, [app.fileRequest]);
  useEffect(() => {
    if (completed) void navigate(path, false);
  }, [completed]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
    const dismiss = (e: globalThis.MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !menuButtonRef.current?.contains(e.target as Node)
      )
        setMenu(null);
    };
    const close = () => setMenu(null);
    const scroll = (e: Event) => {
      // Inputs also emit scroll when their caret moves; only moving file lists
      // invalidates a menu's position.
      if (
        e.target instanceof Element &&
        e.target.classList.contains("file-table-scroll")
      )
        close();
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);
  const visible = entries
    .filter(
      (f) =>
        (hidden || !f.name.startsWith(".")) &&
        f.name.toLowerCase().includes(filter.toLowerCase()),
    )
    .sort((a, b) => {
      if (a.kind === "directory" && b.kind !== "directory") return -1;
      if (b.kind === "directory" && a.kind !== "directory") return 1;
      const av = a[sort.key],
        bv = b[sort.key];
      return (
        (typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), "ko")) *
        (sort.reverse ? -1 : 1)
      );
    });
  const select = (
    e: MouseEvent | React.KeyboardEvent,
    index: number,
    file: FileEntry,
  ) => {
    if (e.shiftKey) {
      const range = visible
        .slice(
          Math.min(anchor.current, index),
          Math.max(anchor.current, index) + 1,
        )
        .map((f) => f.path);
      setSelection(
        e.ctrlKey || e.metaKey ? [...new Set([...selection, ...range])] : range,
      );
    } else if (e.ctrlKey || e.metaKey) {
      setSelection(
        selection.includes(file.path)
          ? selection.filter((p) => p !== file.path)
          : [...selection, file.path],
      );
      anchor.current = index;
    } else {
      setSelection([file.path]);
      anchor.current = index;
    }
  };
  const showMenu = (x: number, y: number, paths: string[], toolbar = false) =>
    setMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - 298)),
      y: Math.max(8, Math.min(y, window.innerHeight - 340)),
      paths,
      toolbar,
    });
  const operation = async (
    action: "mkdir" | "touch" | "rename" | "delete" | "chmod",
    targets = menu?.paths ?? selection,
  ) => {
    setMenu(null);
    if (!endpoint) return;
    let name: string | undefined, mode: number | undefined;
    if (action === "delete") {
      if (
        !(await app.confirm(
          "파일 삭제",
          `${endpoint.label}에서 ${targets.length}개 항목을 삭제할까요? 휴지통으로 이동하지 않습니다.\n${targets.slice(0, 5).join("\n")}`,
        ))
      )
        return;
    } else if (action === "chmod") {
      const f = entries.find((x) => x.path === targets[0]);
      const value = await app.ask(
        "SFTP 권한 변경",
        "소유자 / 그룹 / 기타의 권한을 3자리 8진수로 입력하세요. 예: 755, 644. 특수 비트는 유지됩니다.",
        ((f?.mode ?? 0) & 0o777).toString(8).padStart(3, "0"),
      );
      if (value === null) return;
      if (!/^[0-7]{3}$/.test(value)) {
        app.notify("권한은 0~7의 숫자 3자리입니다.");
        return;
      }
      mode = parseInt(value, 8);
    } else {
      const initial =
        action === "rename"
          ? (entries.find((f) => f.path === targets[0])?.name ?? "")
          : "";
      const value = await app.ask(
        action === "rename"
          ? "이름 변경"
          : action === "mkdir"
            ? "새 폴더"
            : "빈 파일 만들기",
        `위치: ${path}`,
        initial,
      );
      if (value === null) return;
      name = value;
    }
    setBusy(true);
    try {
      await api.call("files.action", {
        id: endpoint.id,
        action,
        paths: action === "mkdir" || action === "touch" ? [path] : targets,
        name,
        mode,
      });
      await navigate(path, false);
    } catch (e) {
      app.notify(e);
    } finally {
      setBusy(false);
    }
  };
  const menuPaths = menu?.paths ?? [],
    menuItem = entries.find((f) => f.path === menuPaths[0]);
  return (
    <section
      className={`file-panel ${drop ? "file-drop" : ""}`}
      aria-label={side ? "오른쪽 파일 패널" : "왼쪽 파일 패널"}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(fileMime)) {
          e.preventDefault();
          setDrop(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrop(false);
        try {
          const payload = JSON.parse(e.dataTransfer.getData(fileMime)) as {
            id: string;
            paths: string[];
          };
          if (payload.id === endpoint?.id)
            throw new Error("반대편 패널에 놓아 주세요.");
          onDropFiles(payload.paths, payload.id);
        } catch (err) {
          app.notify(err);
        }
      }}
    >
      <header className="file-panel-header">
        <div className="endpoint-icon">
          {endpoint?.protocol === "local" ? (
            <HardDrive size={17} />
          ) : app.document.hosts.find((h) => h.id === hostId) ? (
            <HostIcon host={app.document.hosts.find((h) => h.id === hostId)!} />
          ) : (
            <Server size={17} />
          )}
        </div>
        <button
          className="endpoint-picker"
          aria-label={side ? "오른쪽 연결" : "왼쪽 연결"}
          disabled={busy}
          onClick={() => setChoosingHost(true)}
        >
          <span>
            {hostId === "local"
              ? "내 컴퓨터"
              : app.document.hosts.find((h) => h.id === hostId)?.name ||
                "연결 선택"}
          </span>
          <ChevronDown size={16} />
        </button>
        {choosingHost && (
          <HostPicker
            title={side ? "오른쪽 파일 연결" : "왼쪽 파일 연결"}
            local
            onClose={() => setChoosingHost(false)}
            onSelect={(id) => {
              setChoosingHost(false);
              void connect(id);
            }}
          />
        )}
        <IconButton
          label="파일 연결 다시 열기"
          disabled={busy}
          onClick={() => void connect(hostId)}
        >
          <RotateCcw size={15} />
        </IconButton>
        <button
          ref={menuButtonRef}
          className="subtle"
          aria-haspopup="menu"
          aria-expanded={!!menu?.toolbar}
          onClick={(e) => {
            if (menu) {
              setMenu(null);
              return;
            }
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.right - 284, r.bottom, selection, true);
          }}
          disabled={!endpoint || busy}
        >
          작업 <MoreHorizontal size={16} />
        </button>
      </header>
      <div className="path-toolbar">
        <IconButton
          label="이전 폴더"
          disabled={position <= 0 || busy}
          onClick={() => {
            const p = position - 1;
            setPosition(p);
            void navigate(history[p], false);
          }}
        >
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton
          label="다음 폴더"
          disabled={position >= history.length - 1 || busy}
          onClick={() => {
            const p = position + 1;
            setPosition(p);
            void navigate(history[p], false);
          }}
        >
          <ArrowRight size={15} />
        </IconButton>
        <IconButton
          label="상위 폴더"
          disabled={!path || busy}
          onClick={() => void navigate(parentPath(path))}
        >
          <ArrowUp size={15} />
        </IconButton>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void navigate(pathInput);
          }}
        >
          <Folder size={15} />
          <input
            aria-label={side ? "오른쪽 경로" : "왼쪽 경로"}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="경로 입력"
          />
        </form>
        <IconButton
          label="새로고침"
          disabled={busy}
          onClick={() => void navigate(path, false)}
        >
          <RefreshCw size={15} className={busy ? "spinning" : ""} />
        </IconButton>
      </div>
      <div className="file-filter">
        <Search size={14} />
        <input
          aria-label={side ? "오른쪽 파일 필터" : "왼쪽 파일 필터"}
          placeholder="현재 폴더에서 찾기"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="check-label">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
          />
          숨김 파일
        </label>
      </div>
      {error && (
        <div className="inline-error">
          {error}
          <button onClick={() => void connect(hostId)}>다시 연결</button>
        </div>
      )}
      <div
        className="file-table-scroll"
        tabIndex={0}
        onContextMenu={(e) => {
          e.preventDefault();
          if (e.target === e.currentTarget) {
            setSelection([]);
            showMenu(e.clientX, e.clientY, []);
          }
        }}
        onKeyDown={(e) => {
          const platform = shortcutPlatform(app.boot.platform);
          const keys = app.document.settings.shortcuts[platform];
          const mac = app.boot.platform === "darwin";
          if (
            e.nativeEvent.isComposing ||
            (e.target as HTMLElement).closest(
              "input, textarea, select, [contenteditable=true]",
            )
          )
            return;
          // Chromium also generates contextmenu from these keys on Windows.
          // Cancel that default even when the configured binding was removed.
          if (
            shortcutMatch(
              e.nativeEvent,
              defaultShortcuts[platform].fileMenu,
              mac,
            )
          )
            e.preventDefault();
          if (shortcutMatch(e.nativeEvent, keys.fileMenu, mac)) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left + 60, r.top + 50, selection);
          }
          if (shortcutMatch(e.nativeEvent, keys.fileSelectAll, mac)) {
            e.preventDefault();
            setSelection(visible.map((f) => f.path));
          }
          if (shortcutMatch(e.nativeEvent, keys.fileDelete, mac)) {
            e.preventDefault();
            if (!e.repeat && selection.length) void operation("delete");
          }
        }}
        onKeyUp={(e) => {
          // Windows dispatches the dedicated menu key's default on keyup.
          if (e.key === "ContextMenu") e.preventDefault();
        }}
      >
        <table className="file-table">
          <thead>
            <tr>
              {(
                [
                  ["name", "이름"],
                  ["modified", "수정일"],
                  ["size", "크기"],
                  ["kind", "종류"],
                ] as const
              ).map(([key, label]) => (
                <th key={key}>
                  <button
                    onClick={() =>
                      setSort({
                        key,
                        reverse: sort.key === key ? !sort.reverse : false,
                      })
                    }
                  >
                    {label}
                    {sort.key === key &&
                      (sort.reverse ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronUp size={12} />
                      ))}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr
              className="parent-row"
              onClick={() => void navigate(parentPath(path))}
            >
              <td colSpan={4}>
                <button
                  aria-label="상위 폴더로 이동"
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigate(parentPath(path));
                  }}
                >
                  <Folder size={17} />
                  <span>..</span>
                </button>
              </td>
            </tr>
            {visible.map((f, index) => (
              <tr
                key={f.path}
                tabIndex={0}
                className={`${selection.includes(f.path) ? "selected" : ""} ${f.name.startsWith(".") ? "hidden-file" : ""}`}
                onClick={(e) => select(e, index, f)}
                onDoubleClick={() => {
                  if (f.kind === "directory") void navigate(f.path);
                }}
                onKeyDown={(e) => {
                  if (e.key === " ") {
                    e.preventDefault();
                    select(e, index, f);
                  }
                  if (e.key === "Enter" && f.kind === "directory")
                    void navigate(f.path);
                  if (
                    shortcutMatch(
                      e.nativeEvent,
                      app.document.settings.shortcuts[
                        shortcutPlatform(app.boot.platform)
                      ].fileRename,
                      app.boot.platform === "darwin",
                    )
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.repeat) return;
                    setSelection([f.path]);
                    void operation("rename", [f.path]);
                  }
                }}
                draggable
                onDragStart={(e) => {
                  const paths = selection.includes(f.path)
                    ? selection
                    : [f.path];
                  setSelection(paths);
                  e.dataTransfer.setData(
                    fileMime,
                    JSON.stringify({ id: endpoint?.id, paths }),
                  );
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const paths = selection.includes(f.path)
                    ? selection
                    : [f.path];
                  setSelection(paths);
                  showMenu(e.clientX, e.clientY, paths);
                }}
              >
                <td>
                  <div className="file-name">
                    {f.kind === "directory" ? (
                      <Folder size={18} className="folder-icon" />
                    ) : f.kind === "link" ? (
                      <LinkIcon size={17} />
                    ) : (
                      <File size={17} />
                    )}
                    <div>
                      <span title={f.name}>{f.name}</span>
                      {f.mode !== undefined && (
                        <small>
                          {(f.mode & 0o7777).toString(8).padStart(3, "0")}
                        </small>
                      )}
                    </div>
                  </div>
                </td>
                <td>
                  {f.modified
                    ? new Date(f.modified).toLocaleString("ko-KR", {
                        year: "2-digit",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}
                </td>
                <td>{f.kind === "directory" ? "—" : sizeLabel(f.size)}</td>
                <td>
                  {f.kind === "directory"
                    ? "폴더"
                    : f.kind === "link"
                      ? "링크"
                      : "파일"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!busy && !visible.length && (
          <div
            className="folder-empty"
            onContextMenu={(e) => {
              e.preventDefault();
              setSelection([]);
              showMenu(e.clientX, e.clientY, []);
            }}
          >
            {filter ? "조건에 맞는 파일이 없습니다." : "폴더가 비어 있습니다."}
          </div>
        )}
      </div>
      <footer className="panel-status">
        <span>
          {entries.length}개 항목
          {selected.length ? ` · ${selected.length}개 선택` : ""}
        </span>
        <span>{endpoint?.protocol.toUpperCase() ?? "연결 전"}</span>
      </footer>
      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(e) => {
            const buttons = [
              ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            ];
            const current = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (e.key === "Escape") {
              setMenu(null);
              if (menu.toolbar) menuButtonRef.current?.focus();
              e.preventDefault();
              e.stopPropagation();
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              buttons[
                (current + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length
              ]?.focus();
            }
          }}
        >
          <div className="context-caption">
            {menuPaths.length ? `${menuPaths.length}개 선택` : "현재 폴더"}
          </div>
          <button
            role="menuitem"
            disabled={!menuPaths.length || !other.endpoint || busy}
            title={
              other.endpoint
                ? `${other.endpoint.label}: ${other.path}`
                : "반대편 패널을 연결해 주세요."
            }
            onClick={() => {
              onCopy(menuPaths);
              setMenu(null);
            }}
          >
            <Copy size={15} />
            {side ? "왼쪽" : "오른쪽"} 폴더로 복사
          </button>
          <button
            role="menuitem"
            disabled={menuPaths.length !== 1 || busy}
            onClick={() => void operation("rename")}
          >
            <Edit3 size={15} />
            이름 변경
          </button>
          <button
            role="menuitem"
            disabled={busy}
            onClick={() => void navigate(path, false)}
          >
            <RefreshCw size={15} />
            새로고침
          </button>
          <button
            role="menuitem"
            disabled={busy}
            onClick={() => void operation("mkdir")}
          >
            <FolderPlus size={15} />새 폴더
          </button>
          <button
            role="menuitem"
            disabled={busy}
            onClick={() => void operation("touch")}
          >
            <FilePlus size={15} />빈 파일 만들기
          </button>
          {endpoint?.protocol === "sftp" && (
            <button
              role="menuitem"
              disabled={
                busy || menuPaths.length !== 1 || menuItem?.kind === "link"
              }
              onClick={() => void operation("chmod")}
            >
              <Shield size={15} />
              권한 변경
            </button>
          )}
          <div className="menu-divider" />
          <button
            role="menuitem"
            className="danger"
            disabled={!menuPaths.length || busy}
            onClick={() => void operation("delete")}
          >
            <Trash2 size={15} />
            삭제
          </button>
        </div>
      )}
    </section>
  );
}
