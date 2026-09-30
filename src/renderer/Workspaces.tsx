import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  Terminal as TerminalIcon,
  Maximize2,
  Minimize2,
  X,
  Columns2,
  Rows2,
  Unplug,
  Move,
  ArrowUpRight,
  Search,
  Palette,
  Braces,
  Plus,
  Copy,
  Trash2,
  Check,
  Wrench,
  Plug,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import type {
  Appearance,
  Layout,
  Pane,
  Snippet,
  Workspace,
} from "../shared/model";
import {
  panes,
  replaceNode,
  removeNode,
  insertSplit,
  moveLayout,
} from "../shared/layout";
import { paneHost, effectiveHost } from "../shared/advanced";
import { WorkspaceOperations, ExecuteCommand } from "./Advanced";
import { configurePane } from "./terminals";
import { themes, getTheme } from "../shared/themes";
import { useApp } from "./context";
import { api, uuid } from "./api";
import { attachTerminal, applyAppearance, terminals } from "./terminals";
import { HostPicker } from "./HostPicker";
import {
  IconButton,
  Modal,
  Empty,
  NumberField,
  ToggleField,
} from "./components";
export const dragMime = "application/x-passport-layout";
type Edge = "left" | "right" | "top" | "bottom";
const minimum = (n: Layout): [number, number] => {
  if (n.kind === "pane") return [320, 180];
  const a = minimum(n.children[0]),
    b = minimum(n.children[1]);
  return n.direction === "horizontal"
    ? [a[0] + b[0] + 5, Math.max(a[1], b[1])]
    : [Math.max(a[0], b[0]), a[1] + b[1] + 5];
};
function Leaf({
  pane,
  workspace,
  maximized,
  setMaximized,
}: {
  pane: Pane;
  workspace: Workspace;
  maximized: string | null;
  setMaximized: (id: string | null) => void;
}) {
  const app = useApp(),
    host = paneHost(app.document, pane, app.boot.profiles);
  const container = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState<Edge | null>(null),
    [search, setSearch] = useState<string | null>(null),
    [searchResults, setSearchResults] = useState({
      resultIndex: -1,
      resultCount: 0,
    }),
    [split, setSplit] = useState(false),
    [splitDirection, setSplitDirection] = useState<"horizontal" | "vertical">(
      "horizontal",
    ),
    [moving, setMoving] = useState(false),
    [moveTarget, setMoveTarget] = useState(""),
    [moveEdge, setMoveEdge] = useState<Edge>("right");
  const status = app.sessionStates[pane.id]?.status ?? "disconnected";
  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail === pane.id) setSearch("");
    };
    window.addEventListener("passport-search", handler);
    return () => window.removeEventListener("passport-search", handler);
  }, [pane.id]);
  const appearance: Appearance = {
    ...app.document.settings.appearance,
    ...host.appearance,
    ...app.sessionAppearance[pane.id],
  };
  const searchPalette = getTheme(
    appearance.theme,
    app.document.settings.customThemes,
  ).theme;
  useEffect(
    () =>
      container.current
        ? attachTerminal(pane.id, container.current, appearance)
        : undefined,
    [pane.id],
  );
  useEffect(() => {
    applyAppearance(pane.id, appearance);
    configurePane(pane.id, host.backspace);
  }, [pane.id, JSON.stringify(appearance), host.backspace]);
  useEffect(() => {
    const addon = terminals.get(pane.id)?.search;
    const listener = addon?.onDidChangeResults(setSearchResults);
    return () => {
      listener?.dispose();
      addon?.clearDecorations();
    };
  }, [pane.id]);
  const runSearch = (value: string, previous = false, incremental = false) => {
    const entry = terminals.get(pane.id);
    if (!entry) return;
    const palette = searchPalette;
    const blend = (color: string | undefined, ratio: number) => {
      const background = palette.background || "#1e1e2e",
        foreground = color || "#89b4fa";
      return (
        "#" +
        [1, 3, 5]
          .map((start) =>
            Math.round(
              parseInt(background.slice(start, start + 2), 16) * (1 - ratio) +
                parseInt(foreground.slice(start, start + 2), 16) * ratio,
            )
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")
      );
    };
    entry.search[previous ? "findPrevious" : "findNext"](value, {
      incremental,
      decorations: {
        matchBackground: blend(palette.blue, 0.32),
        matchBorder: palette.blue,
        matchOverviewRuler: palette.blue || "#89b4fa",
        activeMatchBackground: blend(palette.blue, 0.62),
        activeMatchBorder: palette.yellow,
        activeMatchColorOverviewRuler: palette.yellow || "#f9e2af",
      },
    });
  };
  const closeSearch = () => {
    setSearch(null);
    terminals.get(pane.id)?.search.clearDecorations();
    terminals.get(pane.id)?.term.clearSelection();
    setSearchResults({ resultIndex: -1, resultCount: 0 });
    terminals.get(pane.id)?.term.focus();
  };
  useEffect(() => {
    if (search !== null) {
      // Refresh all match colors while retaining the currently selected result.
      terminals.get(pane.id)?.search.clearDecorations();
      runSearch(search, false, true);
    }
  }, [JSON.stringify(searchPalette), search === null]);
  const close = async () => {
    if (
      status === "connected" &&
      !(await app.confirm("터미널 닫기", `${host.name}의 연결을 종료할까요?`))
    )
      return;
    await app.update((d) => ({
      ...d,
      workspaces: d.workspaces.flatMap((w) => {
        if (w.id !== workspace.id) return [w];
        const root = removeNode(w.root, pane.id);
        return root ? [{ ...w, root }] : [];
      }),
    }));
  };
  const detach = async () => {
    if (workspace.root.kind === "pane") return;
    const id = uuid();
    const ok = await app.update((d) => ({
      ...d,
      workspaces: [
        ...d.workspaces.flatMap((w) => {
          if (w.id !== workspace.id) return [w];
          const root = removeNode(w.root, pane.id);
          return root ? [{ ...w, root }] : [];
        }),
        { id, name: host.name, root: pane },
      ],
    }));
    if (ok) {
      app.setActive(id);
      setMaximized(null);
    }
  };
  const dropEdge = (event: DragEvent): Edge => {
    const r = event.currentTarget.getBoundingClientRect(),
      x = (event.clientX - r.left) / r.width,
      y = (event.clientY - r.top) / r.height;
    return Math.min(x, 1 - x) < Math.min(y, 1 - y)
      ? x < 0.5
        ? "left"
        : "right"
      : y < 0.5
        ? "top"
        : "bottom";
  };
  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    const side = dropEdge(event);
    setEdge(null);
    try {
      const source = JSON.parse(event.dataTransfer.getData(dragMime)) as {
        workspace: string;
        node: string;
      };
      const r = event.currentTarget.getBoundingClientRect();
      if (side === "left" || side === "right" ? r.width < 645 : r.height < 365)
        throw new Error("분할할 공간이 부족합니다. 창을 확대해 주세요.");
      await app.update((d) => ({
        ...d,
        workspaces: moveLayout(
          d.workspaces,
          source.workspace,
          source.node,
          workspace.id,
          pane.id,
          side,
          uuid(),
        ),
      }));
    } catch (error) {
      app.notify(error);
    }
  };
  const addSplit = async (
    direction: "horizontal" | "vertical",
    splitHost: string,
  ) => {
    const h = app.document.hosts.find((x) => x.id === splitHost);
    if (!h) {
      app.notify("연결할 호스트를 선택해 주세요.");
      return;
    }
    if (app.document.workspaces.flatMap((w) => panes(w.root)).length >= 32) {
      app.notify("최대 32개의 터미널을 열 수 있습니다.");
      return;
    }
    const rect = container.current?.parentElement?.getBoundingClientRect();
    if (
      rect &&
      (direction === "horizontal" ? rect.width < 645 : rect.height < 365)
    ) {
      app.notify("분할할 공간이 부족합니다. 창을 확대해 주세요.");
      return;
    }
    const p: Pane = { kind: "pane", id: uuid(), hostId: h.id };
    const ok = await app.update((d) => ({
      ...d,
      workspaces: d.workspaces.map((w) =>
        w.id === workspace.id
          ? {
              ...w,
              root: insertSplit(
                w.root,
                pane.id,
                p,
                direction === "horizontal" ? "right" : "bottom",
                uuid(),
              ),
            }
          : w,
      ),
    }));
    if (ok) {
      setSplit(false);
      setMaximized(null);
      app.setActivePane(p.id);
      await app.connectPane(p.id, h.id);
    }
  };
  return (
    <section
      className={`terminal-pane ${app.activePane === pane.id ? "focused" : ""}`}
      data-pane-id={pane.id}
      onMouseDown={() => app.setActivePane(pane.id)}
      onFocusCapture={() => app.setActivePane(pane.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(dragMime)) {
          e.preventDefault();
          setEdge(dropEdge(e));
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setEdge(null);
      }}
      onDrop={(e) => void handleDrop(e)}
    >
      <header className="pane-header">
        <div
          className="pane-title"
          draggable
          onDragStart={(e) =>
            e.dataTransfer.setData(
              dragMime,
              JSON.stringify({ workspace: workspace.id, node: pane.id }),
            )
          }
        >
          <TerminalIcon size={14} />
          <strong>{host.name}</strong>
          <span>
            {host.username}@{host.address}
          </span>
        </div>
        <span
          className={`dot ${status}`}
          title={
            status === "connected"
              ? "연결됨"
              : status === "connecting"
                ? "연결 중"
                : "연결 끊김"
          }
        />
        <IconButton
          label="터미널 검색"
          onClick={() => (search === null ? setSearch("") : closeSearch())}
        >
          <Search size={14} />
        </IconButton>
        <IconButton label="터미널 분할" onClick={() => setSplit(!split)}>
          <Columns2 size={14} />
        </IconButton>
        <IconButton label="패널 위치 이동" onClick={() => setMoving(true)}>
          <Move size={14} />
        </IconButton>
        <IconButton
          label="새 탭으로 분리"
          disabled={workspace.root.kind === "pane"}
          onClick={() => void detach()}
        >
          <ArrowUpRight size={14} />
        </IconButton>
        <IconButton
          label={maximized ? "분할 복원" : "집중 보기"}
          onClick={() => setMaximized(maximized ? null : pane.id)}
        >
          {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
        <IconButton label="터미널 닫기" onClick={() => void close()}>
          <X size={14} />
        </IconButton>
      </header>
      {search !== null && (
        <div className="terminal-search">
          <Search size={15} />
          <input
            aria-label="터미널 출력 검색"
            autoFocus
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              runSearch(e.target.value, false, true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch(search, e.shiftKey);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeSearch();
              }
            }}
            placeholder="출력 검색 · Enter 다음 / Shift+Enter 이전"
          />
          <span className="search-count" role="status" aria-label="검색 결과">
            {searchResults.resultIndex < 0 && searchResults.resultCount > 0
              ? "—"
              : searchResults.resultIndex + 1}
            /{searchResults.resultCount}
            {searchResults.resultCount === 1000 ? "+" : ""}
          </span>
          <IconButton
            label="이전 검색 결과"
            disabled={!search || !searchResults.resultCount}
            onClick={() => runSearch(search, true)}
          >
            <ChevronUp size={15} />
          </IconButton>
          <IconButton
            label="다음 검색 결과"
            disabled={!search || !searchResults.resultCount}
            onClick={() => runSearch(search)}
          >
            <ChevronDown size={15} />
          </IconButton>
          <IconButton label="검색 닫기" onClick={closeSearch}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {split && (
        <HostPicker
          title="터미널 분할"
          sshOnly
          onClose={() => setSplit(false)}
          onSelect={(id) => void addSplit(splitDirection, id)}
        >
          <div className="segmented" role="group" aria-label="분할 방향">
            <button
              aria-pressed={splitDirection === "horizontal"}
              onClick={() => setSplitDirection("horizontal")}
            >
              <Columns2 size={16} />
              좌우 분할
            </button>
            <button
              aria-pressed={splitDirection === "vertical"}
              onClick={() => setSplitDirection("vertical")}
            >
              <Rows2 size={16} />
              상하 분할
            </button>
          </div>
        </HostPicker>
      )}
      <div
        className="terminal-mount"
        ref={container}
        style={{
          background: getTheme(
            appearance.theme,
            app.document.settings.customThemes,
          ).theme.background,
        }}
        onKeyDown={(e) => {
          if (
            (e.metaKey || e.ctrlKey) &&
            ["=", "+", "-", "0"].includes(e.key)
          ) {
            e.preventDefault();
            e.stopPropagation();
            app.setSessionAppearance(pane.id, {
              ...app.sessionAppearance[pane.id],
              fontSize:
                e.key === "0"
                  ? 14
                  : Math.max(
                      8,
                      Math.min(
                        36,
                        appearance.fontSize + (e.key === "-" ? -1 : 1),
                      ),
                    ),
            });
          }
        }}
      />
      {status !== "connected" && (
        <div className="connection-banner">
          <span className={`dot ${status}`} />
          <span>
            {app.sessionStates[pane.id]?.message ??
              "연결 전 · 저장된 배치를 복원했습니다."}
          </span>
          <button
            disabled={status === "connecting"}
            onClick={() => void app.connectPane(pane.id, host.id)}
          >
            {status === "connecting" ? "연결 중…" : "연결"}
          </button>
          {status === "connecting" && (
            <IconButton
              label="연결 취소"
              onClick={() =>
                void api
                  .call("session.close", { id: pane.id })
                  .catch(app.notify)
              }
            >
              <X size={14} />
            </IconButton>
          )}
        </div>
      )}
      {edge && <div className={`drop-zone ${edge}`}>여기에 놓아 분할</div>}
      {moving && (
        <Modal title="패널 위치 이동" onClose={() => setMoving(false)}>
          <label>
            옮길 위치
            <select
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
            >
              <option value="">대상 터미널 선택</option>
              {app.document.workspaces.flatMap((w) =>
                panes(w.root)
                  .filter((p) => p.id !== pane.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {w.name} ·{" "}
                      {app.document.hosts.find((h) => h.id === p.hostId)?.name}{" "}
                      · {p.id.slice(0, 4)}
                    </option>
                  )),
              )}
            </select>
          </label>
          <label>
            배치 방향
            <select
              value={moveEdge}
              onChange={(e) => setMoveEdge(e.target.value as Edge)}
            >
              <option value="left">왼쪽</option>
              <option value="right">오른쪽</option>
              <option value="top">위쪽</option>
              <option value="bottom">아래쪽</option>
            </select>
          </label>
          <div className="modal-actions">
            <button onClick={() => setMoving(false)}>취소</button>
            <button
              className="primary"
              disabled={!moveTarget}
              onClick={() =>
                void (async () => {
                  const destination = app.document.workspaces.find((w) =>
                    panes(w.root).some((p) => p.id === moveTarget),
                  );
                  if (!destination) return;
                  const ok = await app.update((d) => ({
                    ...d,
                    workspaces: moveLayout(
                      d.workspaces,
                      workspace.id,
                      pane.id,
                      destination.id,
                      moveTarget,
                      moveEdge,
                      uuid(),
                    ),
                  }));
                  if (ok) {
                    setMoving(false);
                    setMaximized(null);
                    app.setActive(destination.id);
                    app.setActivePane(pane.id);
                  }
                })()
              }
            >
              이동
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
function Branch({
  node,
  workspace,
  maximized,
  setMaximized,
}: {
  node: Layout;
  workspace: Workspace;
  maximized: string | null;
  setMaximized: (id: string | null) => void;
}) {
  const app = useApp(),
    ref = useRef<HTMLDivElement>(null),
    [ratio, setRatio] = useState(node.kind === "split" ? node.ratio : 0.5);
  const moving = useRef(false);
  useEffect(() => {
    if (node.kind === "split" && !moving.current) setRatio(node.ratio);
  }, [node]);
  if (node.kind === "pane")
    return (
      <Leaf
        pane={node}
        workspace={workspace}
        maximized={maximized}
        setMaximized={setMaximized}
      />
    );
  const horizontal = node.direction === "horizontal",
    a = minimum(node.children[0]),
    b = minimum(node.children[1]),
    min = minimum(node);
  const updateRatio = (value: number) =>
    void app.update((d) => ({
      ...d,
      workspaces: d.workspaces.map((w) =>
        w.id === workspace.id
          ? {
              ...w,
              root: replaceNode(w.root, node.id, { ...node, ratio: value }),
            }
          : w,
      ),
    }));
  return (
    <div
      ref={ref}
      className={`split-layout ${node.direction}`}
      style={{
        minWidth: min[0],
        minHeight: min[1],
        gridTemplateColumns: horizontal
          ? `${ratio}fr 5px ${1 - ratio}fr`
          : undefined,
        gridTemplateRows: !horizontal
          ? `${ratio}fr 5px ${1 - ratio}fr`
          : undefined,
      }}
    >
      <Branch
        node={node.children[0]}
        workspace={workspace}
        maximized={maximized}
        setMaximized={setMaximized}
      />
      <div
        className="split-handle"
        role="separator"
        aria-label="분할 크기 조절"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (
            ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(e.key)
          ) {
            e.preventDefault();
            updateRatio(
              Math.max(
                0.1,
                Math.min(
                  0.9,
                  ratio +
                    (["ArrowLeft", "ArrowUp"].includes(e.key) ? -0.05 : 0.05),
                ),
              ),
            );
          }
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          moving.current = true;
          const rect = ref.current!.getBoundingClientRect();
          let value = ratio;
          const dimension = (horizontal ? rect.width : rect.height) - 5;
          const low = a[horizontal ? 0 : 1] / dimension,
            high = 1 - b[horizontal ? 0 : 1] / dimension;
          const move = (event: PointerEvent) => {
            value = Math.max(
              low,
              Math.min(
                high,
                (horizontal
                  ? event.clientX - rect.left
                  : event.clientY - rect.top) / dimension,
              ),
            );
            value = Math.max(0.05, Math.min(0.95, value));
            setRatio(value);
          };
          const end = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            moving.current = false;
            updateRatio(value);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", end, { once: true });
        }}
      />
      <Branch
        node={node.children[1]}
        workspace={workspace}
        maximized={maximized}
        setMaximized={setMaximized}
      />
    </div>
  );
}
export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const app = useApp(),
    [maximized, setMaximized] = useState<string | null>(null),
    [tool, setTool] = useState<"snippets" | "appearance" | "operations" | null>(
      null,
    );
  const focused = maximized
    ? panes(workspace.root).find((p) => p.id === maximized)
    : undefined;
  const ids = panes(workspace.root).map((p) => p.id),
    connected = ids.filter(
      (id) => app.sessionStates[id]?.status === "connected",
    );
  useEffect(() => {
    if (app.active === workspace.id && !ids.includes(app.activePane))
      app.setActivePane(ids[0]);
  }, [app.active, app.activePane, workspace.id, ids.join(",")]);
  return (
    <div className="workspace-view">
      <div className="workspace-bar">
        <div className="row">
          <strong>{workspace.name}</strong>
          <span className="pill">
            {connected.length} / {ids.length} 연결
          </span>
        </div>
        <div className="row">
          <IconButton
            label="배치 연결"
            onClick={() => {
              for (const p of panes(workspace.root))
                if (
                  !["connected", "connecting"].includes(
                    app.sessionStates[p.id]?.status,
                  )
                )
                  void app.connectPane(p.id, p.hostId);
            }}
          >
            <Plug size={17} />
          </IconButton>
          <IconButton
            label="현재 탭 연결 종료"
            onClick={() =>
              void (async () => {
                if (
                  await app.confirm(
                    "현재 탭 연결 종료",
                    `${connected.length}개 연결을 종료할까요? 배치는 유지됩니다.`,
                  )
                )
                  for (const id of ids) await api.call("session.close", { id });
              })().catch(app.notify)
            }
          >
            <Unplug size={15} />
          </IconButton>
          <IconButton
            label="운영 도구"
            aria-pressed={tool === "operations"}
            className={tool === "operations" ? "active" : ""}
            onClick={() => setTool(tool === "operations" ? null : "operations")}
          >
            <Wrench size={17} />
          </IconButton>
          <IconButton
            label="스니펫"
            aria-pressed={tool === "snippets"}
            className={tool === "snippets" ? "active" : ""}
            onClick={() => setTool(tool === "snippets" ? null : "snippets")}
          >
            <Braces size={15} />
          </IconButton>
          <IconButton
            label="외형"
            aria-pressed={tool === "appearance"}
            className={tool === "appearance" ? "active" : ""}
            onClick={() => setTool(tool === "appearance" ? null : "appearance")}
          >
            <Palette size={15} />
          </IconButton>
        </div>
      </div>
      <div className="workspace-body">
        <div className="workspace-scroll">
          {focused ? (
            <Leaf
              pane={focused}
              workspace={workspace}
              maximized={maximized}
              setMaximized={setMaximized}
            />
          ) : (
            <Branch
              node={workspace.root}
              workspace={workspace}
              maximized={maximized}
              setMaximized={setMaximized}
            />
          )}
        </div>
        {tool && (
          <aside className="toolbox">
            <header>
              <h3>
                {tool === "operations"
                  ? "운영 도구"
                  : tool === "snippets"
                    ? "명령어 스니펫"
                    : "터미널 외형"}
              </h3>
              <IconButton label="도구 패널 닫기" onClick={() => setTool(null)}>
                <X size={16} />
              </IconButton>
            </header>
            {tool === "operations" ? (
              <WorkspaceOperations workspace={workspace} />
            ) : tool === "snippets" ? (
              <Snippets workspace={workspace} />
            ) : (
              <AppearancePanel workspace={workspace} />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
function Snippets({ workspace }: { workspace: Workspace }) {
  const app = useApp(),
    [search, setSearch] = useState(""),
    [group, setGroup] = useState(""),
    [draft, setDraft] = useState<Snippet | null>(null),
    [execute, setExecute] = useState<{ text: string; ids: string[] } | null>(
      null,
    );
  const target = panes(workspace.root).find((p) => p.id === app.activePane),
    name = app.document.hosts.find((h) => h.id === target?.hostId)?.name;
  const list = app.document.snippets.filter(
    (s) =>
      (!group || s.group === group) &&
      `${s.name} ${s.description} ${s.content}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      {execute && (
        <ExecuteCommand {...execute} onClose={() => setExecute(null)} />
      )}
      <div className="tool-body">
        <button
          className="primary full"
          onClick={() =>
            setDraft({
              id: uuid(),
              name: "",
              content: "",
              description: "",
              group: "",
            })
          }
        >
          <Plus size={15} />새 스니펫
        </button>
        <div className="search-box">
          <Search size={15} />
          <input
            placeholder="스니펫 검색"
            aria-label="스니펫 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          aria-label="스니펫 그룹"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          <option value="">모든 그룹</option>
          {[
            ...new Set(
              app.document.snippets.map((s) => s.group).filter(Boolean),
            ),
          ].map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <p className="hint">
          선택한 창: {name ?? "없음"}
          <br />
          붙여넣기는 Enter를 전송하지 않습니다.
        </p>
        {list.map((s) => (
          <article className="snippet-card" key={s.id}>
            <div className="row">
              <Braces size={16} />
              <strong>{s.name}</strong>
              <button className="text-button" onClick={() => setDraft(s)}>
                편집
              </button>
            </div>
            {s.description && <p>{s.description}</p>}
            <pre>{s.content}</pre>
            <div className="row">
              <button
                disabled={!target}
                onClick={() => app.paste(s.content, target ? [target.id] : [])}
              >
                선택 창
              </button>
              <button
                onClick={() =>
                  app.paste(
                    s.content,
                    panes(workspace.root)
                      .filter((p) => !p.local)
                      .map((p) => p.id)
                      .filter(
                        (id) => app.sessionStates[id]?.status === "connected",
                      ),
                  )
                }
              >
                현재 탭 전체
              </button>
              <button
                disabled={!target}
                onClick={() =>
                  target && setExecute({ text: s.content, ids: [target.id] })
                }
              >
                선택 창 실행
              </button>
              <button
                onClick={() =>
                  setExecute({
                    text: s.content,
                    ids: panes(workspace.root)
                      .filter(
                        (p) =>
                          !p.local &&
                          app.sessionStates[p.id]?.status === "connected",
                      )
                      .map((p) => p.id),
                  })
                }
              >
                현재 탭 실행
              </button>
            </div>
          </article>
        ))}
        {!list.length && (
          <p className="hint">자주 쓰는 명령어를 저장해 보세요.</p>
        )}
        <div className="section-line" />
        <button
          className="full"
          onClick={() =>
            void api
              .call("data.export", { kind: "snippets" })
              .then((saved) => saved && app.notify("스니펫을 내보냈습니다."))
              .catch(app.notify)
          }
        >
          스니펫 내보내기
        </button>
        <p className="hint">
          스니펫 가져오기는 설정 → 파일 가져오기에서 할 수 있습니다.
        </p>
      </div>
      {draft && (
        <Modal title="스니펫 편집" onClose={() => setDraft(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void app
                .update((d) => ({
                  ...d,
                  snippets: d.snippets.some((s) => s.id === draft.id)
                    ? d.snippets.map((s) => (s.id === draft.id ? draft : s))
                    : [...d.snippets, draft],
                }))
                .then((ok) => {
                  if (ok) setDraft(null);
                });
            }}
          >
            <label>
              이름
              <input
                autoFocus
                required
                maxLength={256}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              그룹
              <input
                value={draft.group}
                onChange={(e) => setDraft({ ...draft, group: e.target.value })}
              />
            </label>
            <label>
              설명
              <input
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </label>
            <label>
              명령어
              <textarea
                className="code"
                rows={8}
                required
                maxLength={65536}
                value={draft.content}
                onChange={(e) =>
                  setDraft({ ...draft, content: e.target.value })
                }
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="danger"
                onClick={() =>
                  void (async () => {
                    if (
                      await app.confirm(
                        "스니펫 삭제",
                        `${draft.name}을 삭제할까요?`,
                      )
                    ) {
                      await app.update((d) => ({
                        ...d,
                        snippets: d.snippets.filter((s) => s.id !== draft.id),
                      }));
                      setDraft(null);
                    }
                  })()
                }
              >
                <Trash2 size={15} />
                삭제
              </button>
              <button type="submit" className="primary">
                저장
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function AppearancePanel({
  workspace,
  section = "all",
}: {
  workspace?: Workspace;
  section?: "all" | "terminal" | "themes";
}) {
  const app = useApp(),
    [scope, setScope] = useState<"global" | "host" | "session">(
      workspace ? "session" : "global",
    );
  const pane = workspace
      ? (panes(workspace.root).find((p) => p.id === app.activePane) ??
        panes(workspace.root)[0])
      : undefined,
    host = pane ? paneHost(app.document, pane, app.boot.profiles) : undefined;
  const appearance = {
    ...app.document.settings.appearance,
    ...(scope !== "global" ? host?.appearance : {}),
    ...(scope === "session" && pane ? app.sessionAppearance[pane.id] : {}),
  };
  const change = (partial: Partial<Appearance>) => {
    if (scope === "session" && pane)
      app.setSessionAppearance(pane.id, {
        ...app.sessionAppearance[pane.id],
        ...partial,
      });
    else if (scope === "host" && host)
      void app.update((d) => ({
        ...d,
        hosts: d.hosts.map((h) =>
          h.id === host.id
            ? { ...h, appearance: { ...h.appearance, ...partial } }
            : h,
        ),
      }));
    else
      void app.update((d) => ({
        ...d,
        settings: {
          ...d.settings,
          appearance: { ...d.settings.appearance, ...partial },
        },
      }));
  };
  return (
    <div className="tool-body appearance-panel">
      {workspace && (
        <label>
          적용 범위
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="session">현재 창 · 임시</option>
            <option value="host" disabled={!!pane?.local}>
              현재 호스트 · 저장
            </option>
            <option value="global">전체 기본값 · 저장</option>
          </select>
        </label>
      )}
      {section !== "themes" && (
        <div className="appearance-fields">
          <label>
            글꼴
            <input
              list="terminal-fonts"
              value={appearance.font}
              onChange={(e) =>
                change({ font: e.target.value || "JetBrains Mono" })
              }
            />
            <datalist id="terminal-fonts">
              {[
                ...new Set([
                  "JetBrains Mono",
                  "Menlo",
                  "Monaco",
                  "Consolas",
                  "Cascadia Mono",
                  "Courier New",
                  ...app.boot.fonts,
                ]),
              ].map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </label>
          <label>
            글자 크기 <span>{appearance.fontSize}px</span>
            <input
              aria-label="글자 크기"
              type="range"
              min="8"
              max="36"
              value={appearance.fontSize}
              onChange={(e) => change({ fontSize: Number(e.target.value) })}
            />
          </label>
          <label>
            줄 간격
            <NumberField
              step="0.1"
              min="1"
              max="2"
              value={appearance.lineHeight}
              onChange={(value) => change({ lineHeight: value })}
            />
          </label>
          <label>
            자간
            <NumberField
              step="0.1"
              min="-1"
              max="5"
              value={appearance.letterSpacing}
              onChange={(value) => change({ letterSpacing: value })}
            />
          </label>
          <label>
            글자 굵기
            <select
              value={appearance.fontWeight}
              onChange={(e) =>
                change({
                  fontWeight: e.target.value as Appearance["fontWeight"],
                })
              }
            >
              <option value="normal">보통</option>
              <option value="bold">굵게</option>
            </select>
          </label>
          <label>
            커서 모양
            <select
              value={appearance.cursorStyle}
              onChange={(e) =>
                change({
                  cursorStyle: e.target.value as Appearance["cursorStyle"],
                })
              }
            >
              <option value="block">블록</option>
              <option value="bar">막대</option>
              <option value="underline">밑줄</option>
            </select>
          </label>
          <ToggleField
            label="커서 깜빡임"
            checked={appearance.cursorBlink}
            onChange={(value) => change({ cursorBlink: value })}
          />
          <label>
            출력 강조
            <select
              aria-label="출력 강조"
              value={appearance.highlight}
              onChange={(e) =>
                change({ highlight: e.target.value as Appearance["highlight"] })
              }
            >
              <option value="none">기본 출력</option>
              <option value="log">로그 표식 강조</option>
              <option value="line">로그 행 강조</option>
              <option value="address">주소 강조</option>
            </select>
          </label>
          <ToggleField
            label="IP · URL 함께 강조"
            checked={appearance.highlightAddresses}
            onChange={(value) => change({ highlightAddresses: value })}
          />
          <ToggleField
            label="파일·폴더 색상 구분"
            checked={appearance.highlightFiles}
            onChange={(value) => change({ highlightFiles: value })}
          />
        </div>
      )}
      {section !== "terminal" && (
        <>
          {section === "all" && <div className="section-line" />}
          <h4>
            테마{" "}
            <span className="muted">
              {themes.length + app.document.settings.customThemes.length}
            </span>
          </h4>
          <div className="theme-list">
            {[
              ...themes,
              ...app.document.settings.customThemes.map((t) =>
                getTheme(t.id, app.document.settings.customThemes),
              ),
            ].map((t) => (
              <button
                key={t.id}
                className={`theme-item ${appearance.theme === t.id ? "selected" : ""}`}
                onClick={() => change({ theme: t.id })}
              >
                <span
                  className="theme-preview"
                  style={{ background: t.theme.background }}
                >
                  <i style={{ background: t.theme.foreground }} />
                  <i style={{ background: t.theme.green }} />
                  <i style={{ background: t.theme.blue }} />
                  <i style={{ background: t.theme.magenta }} />
                </span>
                <span>{t.name}</span>
                {appearance.theme === t.id && <Check size={14} />}
              </button>
            ))}
          </div>
          <p className="hint">
            테마는 화면 색상에 적용됩니다. 서버의 셸 설정은 변경하지 않습니다.
          </p>
        </>
      )}
    </div>
  );
}
