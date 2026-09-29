import { useCallback, useEffect, useRef, useState } from "react";
import {
  Server,
  Folder,
  Terminal as TerminalIcon,
  Plus,
  Settings as SettingsIcon,
  X,
  ArrowUpRight,
  ShieldCheck,
  Search,
  Info,
} from "lucide-react";
import type {
  Appearance,
  Bootstrap,
  Host,
  PassportDocument,
  Secret,
  SessionState,
  TransferJob,
} from "../shared/model";
import { panes, preparePaste } from "../shared/layout";
import { api, uuid, message } from "./api";
import { AppContext } from "./context";
import { Hosts } from "./Hosts";
import { FilesView } from "./FilesView";
import { WorkspaceView, dragMime } from "./Workspaces";
import { Settings, SecretEditor, blankSecret } from "./Settings";
import { IconButton, Modal } from "./components";
import {
  configureTerminals,
  ensureTerminal,
  terminals,
  disposeMissing,
  serializeTerminals,
  hydrateTerminals,
  setBroadcast,
  setTerminalSettings,
} from "./terminals";
import {
  effectiveHost,
  LOCAL_HOST_ID,
  shortcutMatch,
  variables,
  interpolate,
} from "../shared/advanced";
import icon from "../../design/icons/04-passport-terminal-v2.png";
type Request =
  | {
      type: "ask" | "confirm";
      title: string;
      description: string;
      initial: string;
      resolve: (value: string | null) => void;
      id: string;
    }
  | {
      type: "credential";
      host: Host;
      resolve: (value: Secret | null) => void;
      id: string;
    };
export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [active, setActive] = useState("hosts"),
    [activePane, setActivePane] = useState(""),
    [states, setStates] = useState<Record<string, SessionState>>({}),
    [jobs, setJobs] = useState<TransferJob[]>([]),
    [toast, setToast] = useState<string | null>(null),
    [requests, setRequests] = useState<Request[]>([]),
    [chooser, setChooser] = useState(false),
    [hostSearch, setHostSearch] = useState(""),
    [fileRequest, setFileRequest] = useState<{
      side: number;
      hostId: string;
      nonce: number;
    } | null>(null),
    [sessionAppearance, setSessionAppearance] = useState<
      Record<string, Partial<Appearance>>
    >({}),
    [pastePreview, setPastePreview] = useState<{
      text: string;
      ids: string[];
    } | null>(null),
    [fatal, setFatal] = useState("");
  const bootRef = useRef(boot),
    queue = useRef<Promise<unknown>>(Promise.resolve()),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    tabHover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    statusRef = useRef(states);
  bootRef.current = boot;
  statusRef.current = states;
  const notify = useCallback((error: unknown) => {
    setToast(typeof error === "string" ? error : message(error));
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6500);
  }, []);
  const refresh = useCallback(async () => {
    const data = await api.call("bootstrap", undefined);
    bootRef.current = data;
    setBoot(data);
    setStates(Object.fromEntries(data.sessionStates.map((s) => [s.id, s])));
  }, []);
  const update = useCallback(
    (fn: (d: PassportDocument) => PassportDocument): Promise<boolean> => {
      const operation = queue.current.then(async () => {
        if (!bootRef.current) return false;
        try {
          const doc = fn(structuredClone(bootRef.current.document));
          await api.call("save", doc);
          // The document event and IPC reply may arrive in either order.
          // Read ownership with the saved document before activating new tabs.
          await refresh();
          return true;
        } catch (e) {
          notify(e);
          await refresh();
          return false;
        }
      });
      queue.current = operation;
      return operation;
    },
    [notify, refresh],
  );
  useEffect(() => {
    void refresh().catch((e) => setFatal(message(e)));
    const off = api.onEvent((event) => {
      if (event.kind === "session") {
        const known = bootRef.current?.document.workspaces.some(
          (w) =>
            bootRef.current?.workspaceOwners[w.id] ===
              bootRef.current?.windowId &&
            panes(w.root).some((p) => p.id === event.state.id),
        );
        if (!known && !terminals.has(event.state.id)) return;
        const entry = ensureTerminal(event.state.id);
        entry.connected = event.state.status === "connected";
        setStates((prev) => ({ ...prev, [event.state.id]: event.state }));
      } else if (event.kind === "output") {
        if (
          !bootRef.current?.document.workspaces.some(
            (w) =>
              bootRef.current?.workspaceOwners[w.id] ===
                bootRef.current?.windowId &&
              panes(w.root).some((p) => p.id === event.id),
          )
        ) {
          void api
            .call("session.ack", { id: event.id, bytes: event.bytes })
            .catch(() => {});
          return;
        }
        const entry = ensureTerminal(event.id);
        entry.term.write(
          event.data,
          () =>
            void api
              .call("session.ack", { id: event.id, bytes: event.bytes })
              .catch(() => {}),
        );
      } else if (event.kind === "transfer")
        setJobs((prev) =>
          prev.some((j) => j.id === event.job.id)
            ? prev.map((j) => (j.id === event.job.id ? event.job : j))
            : [...prev, event.job],
        );
      else if (event.kind === "document") {
        if (bootRef.current) {
          const next = {
            ...bootRef.current,
            document: event.document,
            profiles: event.profiles,
            workspaceOwners: event.workspaceOwners,
          };
          bootRef.current = next;
          setBoot(next);
        }
      } else if (event.kind === "window-transfer") {
        setBroadcast([]);
        const w = bootRef.current?.document.workspaces.find(
          (w) => w.id === event.workspaceId,
        );
        if (w)
          void serializeTerminals(
            panes(w.root).map((p) => p.id),
            sessionAppearance,
          )
            .then((snapshots) =>
              api.call("window.snapshot", { token: event.token, snapshots }),
            )
            .catch(notify);
      } else if (event.kind === "hydrate") {
        hydrateTerminals(event.snapshots);
        setSessionAppearance((p) => ({
          ...p,
          ...Object.fromEntries(
            event.snapshots.map((s) => [s.id, s.appearance || {}]),
          ),
        }));
        setActive(event.workspaceId);
      }
    });
    return () => {
      off();
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!boot) return;
    disposeMissing(
      new Set(
        boot.document.workspaces
          .filter((w) => boot.workspaceOwners[w.id] === boot.windowId)
          .flatMap((w) => panes(w.root).map((p) => p.id)),
      ),
    );
    if (
      !["hosts", "files", "settings"].includes(active) &&
      !boot.document.workspaces.some(
        (w) => w.id === active && boot.workspaceOwners[w.id] === boot.windowId,
      )
    )
      setActive(
        boot.document.workspaces
          .filter((w) => boot.workspaceOwners[w.id] === boot.windowId)
          .at(-1)?.id ?? "hosts",
      );
  }, [boot?.document.workspaces, boot?.workspaceOwners]);
  useEffect(() => {
    setBroadcast([]);
  }, [active]);
  useEffect(() => {
    if (boot) setTerminalSettings(boot.document.settings);
  }, [boot?.document.settings]);
  useEffect(() => {
    const mode = boot?.document.settings.colorMode ?? "system";
    const query = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        mode === "system" ? (query.matches ? "dark" : "light") : mode);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [boot?.document.settings.colorMode]);
  const ask = (title: string, description: string, initial = "") =>
    new Promise<string | null>((resolve) =>
      setRequests((q) => [
        ...q,
        { type: "ask", title, description, initial, resolve, id: uuid() },
      ]),
    );
  const confirm = (title: string, description: string) =>
    new Promise<boolean>((resolve) =>
      setRequests((q) => [
        ...q,
        {
          type: "confirm",
          id: uuid(),
          title,
          description,
          initial: "",
          resolve: (value) => resolve(value !== null),
        },
      ]),
    );
  const credentials = async (
    host: Host,
    sftp = false,
  ): Promise<Secret | undefined | null> => {
    if (bootRef.current) host = effectiveHost(bootRef.current.document, host);
    const authId = sftp ? (host.sftpAuthId ?? host.authId) : host.authId;
    if (bootRef.current?.profiles.find((p) => p.id === authId)?.hasSecret)
      return undefined;
    return new Promise<Secret | null>((resolve) =>
      setRequests((q) => [
        ...q,
        { type: "credential", host, resolve, id: uuid() },
      ]),
    );
  };
  const connectPane = async (id: string, hostId: string) => {
    try {
      const doc = bootRef.current?.document;
      if (!doc) return;
      const pane = doc.workspaces
        .flatMap((w) => panes(w.root))
        .find((p) => p.id === id);
      if (pane?.local) {
        ensureTerminal(id);
        await api.call("session.connect", { id, hostId });
        return;
      }
      const raw = doc.hosts.find((h) => h.id === hostId);
      const host = raw ? effectiveHost(doc, raw) : undefined;
      if (!host) return;
      const secret = await credentials(host);
      if (secret === null) return;
      ensureTerminal(id);
      await api.call("session.connect", { id, hostId, secret });
    } catch (e) {
      notify(e);
    }
  };
  const openHost = async (host: Host) => {
    if (host.protocol !== "ssh") {
      setActive("files");
      setFileRequest({ side: 1, hostId: host.id, nonce: Date.now() });
      return;
    }
    const id = uuid(),
      paneId = uuid();
    const ok = await update((d) => ({
      ...d,
      workspaces: [
        ...d.workspaces,
        {
          id,
          name: host.name,
          root: { kind: "pane", id: paneId, hostId: host.id },
        },
      ],
    }));
    if (ok) {
      setActive(id);
      setActivePane(paneId);
      setChooser(false);
      await connectPane(paneId, host.id);
    }
  };
  const paste = (text: string, ids: string[]) => {
    const connected = [...new Set(ids)].filter(
      (id) => statusRef.current[id]?.status === "connected",
    );
    if (!connected.length) {
      notify("연결된 대상 터미널이 없습니다.");
      return;
    }
    void (async () => {
      const values: Record<string, string> = {};
      for (const name of variables(text)) {
        const value = await ask(
          `변수 ${name}`,
          "명령에 넣을 텍스트를 입력하세요.",
        );
        if (value === null) return;
        values[name] = value;
      }
      setPastePreview({
        text: interpolate(text, values).replace(/[\r\n]+$/, ""),
        ids: connected,
      });
    })();
  };
  useEffect(() => {
    configureTerminals(paste, notify);
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const shortcuts = bootRef.current?.document.settings.shortcuts;
      if (!shortcuts) return;
      const mac = bootRef.current?.platform === "darwin";
      if (shortcutMatch(e, shortcuts.newTab, mac)) {
        e.preventDefault();
        e.stopPropagation();
        setChooser(true);
        return;
      }
      if (shortcutMatch(e, shortcuts.search, mac)) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("passport-search", { detail: activePane }),
        );
        return;
      }
      const previous = shortcutMatch(e, shortcuts.previousPane, mac);
      if (previous || shortcutMatch(e, shortcuts.nextPane, mac)) {
        const workspace = bootRef.current?.document.workspaces.find(
          (w) => w.id === active,
        );
        if (!workspace) return;
        e.preventDefault();
        e.stopPropagation();
        const ids = panes(workspace.root).map((p) => p.id),
          index = ids.indexOf(activePane),
          next = ids[(index + (previous ? -1 : 1) + ids.length) % ids.length];
        setActivePane(next);
        terminals.get(next)?.term.focus();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active, activePane]);
  const closeTab = async (id: string) => {
    const w = bootRef.current?.document.workspaces.find((w) => w.id === id);
    if (!w) return;
    const count = panes(w.root).filter(
      (p) =>
        states[p.id]?.status === "connected" ||
        states[p.id]?.status === "connecting",
    ).length;
    if (
      count &&
      !(await confirm(
        "작업 탭 닫기",
        `${w.name}의 연결 ${count}개를 종료할까요?`,
      ))
    )
      return;
    await update((d) => ({
      ...d,
      workspaces: d.workspaces.filter((w) => w.id !== id),
    }));
  };
  if (fatal)
    return (
      <div className="boot-screen">
        <img src={icon} />
        <h1>Passport를 시작할 수 없습니다.</h1>
        <p>{fatal}</p>
        <button onClick={() => location.reload()}>다시 시도</button>
      </div>
    );
  if (!boot)
    return (
      <div className="boot-screen">
        <img src={icon} />
        <h1>Passport</h1>
        <p>작업 공간을 준비하고 있습니다.</p>
      </div>
    );
  const connected = Object.values(states).filter(
    (s) => s.status === "connected",
  ).length;
  return (
    <AppContext.Provider
      value={{
        boot,
        document: boot.document,
        update,
        refresh,
        notify,
        ask,
        confirm,
        credentials,
        openHost,
        connectPane,
        active,
        setActive,
        activePane,
        setActivePane,
        sessionStates: states,
        jobs,
        fileRequest,
        openFiles: (host, side) => {
          setActive("files");
          setFileRequest({ side, hostId: host.id, nonce: Date.now() });
        },
        paste,
        sessionAppearance,
        setSessionAppearance: (id, value) =>
          setSessionAppearance((p) => ({ ...p, [id]: value })),
      }}
    >
      <div className={`app ${boot.platform === "darwin" ? "mac" : ""}`}>
        <header className="app-titlebar">
          <div className="brand">
            <img src={icon} alt="" />
            <span>Passport</span>
          </div>
          <nav className="tabs" aria-label="작업 탭">
            <button
              className={`app-tab fixed ${active === "hosts" ? "active" : ""}`}
              onClick={() => setActive("hosts")}
            >
              <Server size={15} />
              호스트
            </button>
            <button
              className={`app-tab fixed ${active === "files" ? "active" : ""}`}
              onClick={() => setActive("files")}
            >
              <Folder size={15} />
              파일
            </button>
            {boot.document.workspaces
              .filter((w) => boot.workspaceOwners[w.id] === boot.windowId)
              .map((w) => (
                <div
                  key={w.id}
                  className={`app-tab workspace-tab ${active === w.id ? "active" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      dragMime,
                      JSON.stringify({ workspace: w.id, node: w.root.id }),
                    );
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(dragMime)) {
                      e.preventDefault();
                      if (!tabHover.current)
                        tabHover.current = setTimeout(() => {
                          setActive(w.id);
                          tabHover.current = undefined;
                        }, 350);
                    }
                  }}
                  onDragLeave={() => {
                    clearTimeout(tabHover.current);
                    tabHover.current = undefined;
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    clearTimeout(tabHover.current);
                    tabHover.current = undefined;
                    try {
                      const source = JSON.parse(
                        e.dataTransfer.getData(dragMime),
                      ) as { workspace: string; node: string };
                      if (source.workspace === w.id) return;
                      void update((d) => {
                        const from = d.workspaces.findIndex(
                            (x) => x.id === source.workspace,
                          ),
                          to = d.workspaces.findIndex((x) => x.id === w.id);
                        if (from < 0 || to < 0) return d;
                        const next = [...d.workspaces];
                        next.splice(to, 0, next.splice(from, 1)[0]);
                        return { ...d, workspaces: next };
                      });
                    } catch {}
                  }}
                >
                  <button
                    onClick={() => {
                      setActive(w.id);
                      setActivePane(panes(w.root)[0].id);
                    }}
                    onDoubleClick={() =>
                      void ask(
                        "작업 탭 이름",
                        "이름을 입력해 주세요.",
                        w.name,
                      ).then((name) => {
                        if (name?.trim())
                          void update((d) => ({
                            ...d,
                            workspaces: d.workspaces.map((x) =>
                              x.id === w.id ? { ...x, name: name.trim() } : x,
                            ),
                          }));
                      })
                    }
                  >
                    <TerminalIcon size={14} />
                    <span>{w.name}</span>
                    {panes(w.root).length > 1 && (
                      <small>{panes(w.root).length}</small>
                    )}
                  </button>
                  <IconButton
                    label={`${w.name} 탭 닫기`}
                    onClick={() => void closeTab(w.id)}
                  >
                    <X size={13} />
                  </IconButton>
                </div>
              ))}
            <IconButton label="새 SSH 탭" onClick={() => setChooser(true)}>
              <Plus size={18} />
            </IconButton>
          </nav>
          <IconButton
            label="설정"
            className={active === "settings" ? "active" : ""}
            onClick={() => setActive("settings")}
          >
            <SettingsIcon size={18} />
          </IconButton>
        </header>
        <main className="app-main">
          <div className="view" hidden={active !== "hosts"}>
            <Hosts />
          </div>
          <div className="view" hidden={active !== "files"}>
            <FilesView />
          </div>
          <div className="view" hidden={active !== "settings"}>
            <Settings />
          </div>
          {boot.document.workspaces
            .filter((w) => boot.workspaceOwners[w.id] === boot.windowId)
            .map((w) => (
              <div className="view" hidden={active !== w.id} key={w.id}>
                <WorkspaceView workspace={w} />
              </div>
            ))}
        </main>
        <footer className="app-status">
          <div>
            <ShieldCheck size={12} />
            <span>로컬 작업 공간</span>
            <span className="divider" />
            <span>{connected}개 SSH 연결</span>
          </div>
          <div>
            {jobs.some((j) => j.state === "running") && (
              <span>
                {jobs.filter((j) => j.state === "running").length}개 전송 중
              </span>
            )}
            <span>Passport 0.3.0</span>
          </div>
        </footer>
        {toast && (
          <div className="toast" role="status">
            <Info size={16} />
            <span>{toast}</span>
            <IconButton label="알림 닫기" onClick={() => setToast(null)}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        {chooser && (
          <Modal title="SSH 연결 열기" onClose={() => setChooser(false)}>
            <div className="row">
              <label>
                로컬 셸
                <select id="local-shell">
                  {boot.shells.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() =>
                  void (async () => {
                    const shell = (
                      document.getElementById(
                        "local-shell",
                      ) as HTMLSelectElement
                    ).value as import("../shared/model").LocalShell["shell"];
                    const id = uuid(),
                      paneId = uuid();
                    const ok = await update((d) => ({
                      ...d,
                      workspaces: [
                        ...d.workspaces,
                        {
                          id,
                          name: "로컬 터미널",
                          root: {
                            kind: "pane",
                            id: paneId,
                            hostId: LOCAL_HOST_ID,
                            local: { shell, cwd: "" },
                          },
                        },
                      ],
                    }));
                    if (ok) {
                      setActive(id);
                      setActivePane(paneId);
                      setChooser(false);
                      await connectPane(paneId, LOCAL_HOST_ID);
                    }
                  })()
                }
              >
                로컬 터미널 열기
              </button>
            </div>
            <div className="section-line" />
            <div className="search-box">
              <Search size={16} />
              <input
                autoFocus
                aria-label="연결할 호스트 검색"
                placeholder="호스트 검색"
                value={hostSearch}
                onChange={(e) => setHostSearch(e.target.value)}
              />
            </div>
            <div className="connection-chooser">
              {boot.document.hosts
                .filter(
                  (h) =>
                    h.protocol === "ssh" &&
                    `${h.name} ${h.address}`
                      .toLowerCase()
                      .includes(hostSearch.toLowerCase()),
                )
                .map((h) => (
                  <button key={h.id} onClick={() => void openHost(h)}>
                    <Server size={18} />
                    <div>
                      <strong>{h.name}</strong>
                      <small>
                        {h.username}@{h.address}:{h.port}
                      </small>
                    </div>
                    <ArrowUpRight size={16} />
                  </button>
                ))}
            </div>
            <button
              className="full"
              onClick={() => {
                setChooser(false);
                setActive("hosts");
              }}
            >
              호스트 관리로 이동
            </button>
          </Modal>
        )}
        {pastePreview && (
          <Modal
            title="터미널에 붙여넣기"
            onClose={() => setPastePreview(null)}
            wide
          >
            <p>대상 {pastePreview.ids.length}개 · Enter를 전송하지 않습니다.</p>
            <div className="paste-targets">
              {pastePreview.ids.map((id) => {
                const pane = boot.document.workspaces
                    .flatMap((w) => panes(w.root))
                    .find((p) => p.id === id),
                  host = boot.document.hosts.find((h) => h.id === pane?.hostId);
                return (
                  <span className="pill" key={id}>
                    {host?.name} · {host?.username}
                  </span>
                );
              })}
            </div>
            <label>
              내용
              <textarea
                className="code"
                rows={8}
                value={pastePreview.text}
                onChange={(e) =>
                  setPastePreview({ ...pastePreview, text: e.target.value })
                }
              />
            </label>
            <p className="hint">
              여러 줄 입력은 bracketed paste를 지원하는 대상에만 전달합니다.
            </p>
            <div className="modal-actions">
              <button onClick={() => setPastePreview(null)}>취소</button>
              <button
                className="primary"
                onClick={() => {
                  const failures: string[] = [];
                  let count = 0;
                  for (const id of pastePreview.ids) {
                    const entry = terminals.get(id);
                    try {
                      if (!entry?.connected)
                        throw new Error("연결이 종료되었습니다.");
                      entry.term.paste(
                        preparePaste(
                          pastePreview.text,
                          entry.term.modes.bracketedPasteMode,
                        ),
                      );
                      count++;
                    } catch (e) {
                      const pane = boot.document.workspaces
                        .flatMap((w) => panes(w.root))
                        .find((p) => p.id === id);
                      failures.push(
                        `${boot.document.hosts.find((h) => h.id === pane?.hostId)?.name ?? id}: ${message(e)}`,
                      );
                    }
                  }
                  setPastePreview(null);
                  notify(
                    `${count}개 터미널에 붙여넣었습니다.${failures.length ? "\n" + failures.join("\n") : ""}`,
                  );
                  terminals.get(activePane)?.term.focus();
                }}
              >
                붙여넣기
              </button>
            </div>
          </Modal>
        )}
        {requests[0] && (
          <RequestDialog
            key={requests[0].id}
            request={requests[0]}
            done={() => setRequests((q) => q.slice(1))}
          />
        )}
      </div>
    </AppContext.Provider>
  );
}
function RequestDialog({
  request,
  done,
}: {
  request: Request;
  done: () => void;
}) {
  const [text, setText] = useState(
      request.type === "credential" ? "" : request.initial,
    ),
    [secret, setSecret] = useState(blankSecret());
  const close = () => {
    request.resolve(null);
    done();
  };
  return (
    <Modal
      title={
        request.type === "credential"
          ? `${request.host.name} 인증`
          : request.title
      }
      onClose={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (request.type === "credential") {
            if (secret.type === "key" && !secret.privateKey) return;
            request.resolve(secret);
          } else request.resolve(text);
          done();
        }}
      >
        {request.type === "credential" ? (
          <>
            <p className="hint">
              {request.host.username}@{request.host.address}:{request.host.port}
              <br />
              이번 연결에만 사용하며 저장하지 않습니다.
            </p>
            <SecretEditor secret={secret} onChange={setSecret} />
          </>
        ) : (
          <>
            <p className="dialog-description">{request.description}</p>
            {request.type === "ask" && (
              <input
                aria-label={request.title}
                autoFocus
                required
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </>
        )}
        <div className="modal-actions">
          <button type="button" onClick={close}>
            취소
          </button>
          <button
            type="submit"
            className={request.type === "confirm" ? "danger filled" : "primary"}
          >
            {request.type === "credential"
              ? "연결"
              : request.type === "confirm"
                ? "확인"
                : "적용"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
