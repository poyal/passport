import { useCallback, useEffect, useRef, useState } from "react";
import {
  Server,
  Folder,
  Terminal as TerminalIcon,
  Plus,
  Settings as SettingsIcon,
  X,
  ShieldCheck,
  Info,
  Download,
  Layers,
  Bell,
  House,
  PanelLeft,
} from "lucide-react";
import type {
  Appearance,
  Activity,
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
import { TemplateEditor } from "./TemplateEditor";
import { ActivityView } from "./Activity";
import { Hosts } from "./Hosts";
import { FilesView } from "./FilesView";
import { WorkspaceTemplates } from "./WorkspaceTemplates";
import { WorkspaceView, dragMime, dragGroupMime } from "./Workspaces";
import { Settings, SecretEditor, blankSecret } from "./Settings";
import { IconButton, Modal, Tooltips } from "./components";
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
  LOCAL_HOST_ID,
  effectiveHost,
  connectionHost,
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
    [active, setActive] = useState("home"),
    [activePane, setActivePane] = useState(""),
    [localFocus, setLocalFocus] = useState<{
      workspaceId: string;
      paneId: string;
    } | null>(null),
    [states, setStates] = useState<Record<string, SessionState>>({}),
    [jobs, setJobs] = useState<TransferJob[]>([]),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [settingsSection, setSettingsSection] = useState("appearance"),
    [requests, setRequests] = useState<Request[]>([]),
    [templateEditor, setTemplateEditor] = useState<{
      workspaceId?: string;
      templateId?: string;
    } | null>(null),
    [sidebarCollapsed, setSidebarCollapsed] = useState(false),
    [activities, setActivities] = useState<Activity[]>([]),
    [activation, setActivation] = useState<{
      workspaceId: string;
      paneId: string;
    } | null>(null),
    [fileRequest, setFileRequest] = useState<{
      side: number;
      hostId: string;
      nonce: number;
    } | null>(null),
    [sessionAppearance, setSessionAppearance] = useState<
      Record<string, Partial<Appearance>>
    >({}),
    [bootIconReady, setBootIconReady] = useState(false),
    [fatal, setFatal] = useState("");
  const bootRef = useRef(boot),
    updateRef = useRef<Bootstrap["updateState"] | null>(null),
    queue = useRef<Promise<unknown>>(Promise.resolve()),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    tabHover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    statusRef = useRef(states);
  bootRef.current = boot;
  statusRef.current = states;
  const notify = useCallback((error: unknown) => {
    const isError = typeof error !== "string";
    setToast({ text: isError ? message(error) : error, error: isError });
    clearTimeout(toastTimer.current);
    if (!isError) toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => {
    const rejection = (e: PromiseRejectionEvent) => {
      e.preventDefault();
      notify(
        e.reason instanceof Error ? e.reason : new Error(message(e.reason)),
      );
    };
    window.addEventListener("unhandledrejection", rejection);
    return () => window.removeEventListener("unhandledrejection", rejection);
  }, [notify]);
  const selectionRestored = useRef(false);
  const refresh = useCallback(async () => {
    const data = await api.call("bootstrap", undefined);
    if (updateRef.current) data.updateState = updateRef.current;
    bootRef.current = data;
    setBoot(data);
    void api.call("activity.list", undefined).then(setActivities).catch(notify);
    setStates(Object.fromEntries(data.sessionStates.map((s) => [s.id, s])));
    if (!selectionRestored.current) {
      selectionRestored.current = true;
      try {
        const selected = JSON.parse(
          localStorage.getItem("passport-selection") || "null",
        );
        const workspace = data.document.workspaces.find(
          (w) =>
            w.id === selected?.workspace &&
            data.workspaceOwners[w.id] === data.windowId,
        );
        if (workspace) {
          setActive(workspace.id);
          setActivePane(
            panes(workspace.root).find((p) => p.id === selected?.pane)?.id ||
              panes(workspace.root)[0].id,
          );
        }
      } catch {
        /* selection is optional */
      }
    }
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
      if (event.kind === "activity") {
        setActivities(event.items);
      } else if (event.kind === "activate-pane") {
        setActivation(event);
      } else if (event.kind === "session") {
        const known = bootRef.current?.document.workspaces.some(
          (w) =>
            bootRef.current?.workspaceOwners[w.id] ===
              bootRef.current?.windowId &&
            panes(w.root).some((p) => p.id === event.state.id),
        );
        if (!known && !terminals.has(event.state.id)) return;
        const entry = ensureTerminal(event.state.id);
        entry.connected = event.state.status === "connected";
        if (event.state.status === "error")
          notify(new Error(event.state.message || "서버 연결에 실패했습니다."));
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
      } else if (event.kind === "transfer") {
        if (event.job.state === "error")
          notify(new Error(event.job.error || "파일 전송에 실패했습니다."));
        setJobs((prev) =>
          prev.some((j) => j.id === event.job.id)
            ? prev.map((j) => (j.id === event.job.id ? event.job : j))
            : [...prev, event.job],
        );
      } else if (event.kind === "notice") {
        notify(new Error(event.message));
      } else if (event.kind === "update") {
        updateRef.current = event.state;
        if (bootRef.current) {
          const next = { ...bootRef.current, updateState: event.state };
          bootRef.current = next;
          setBoot(next);
        }
      } else if (event.kind === "tunnel" && event.state.status === "error") {
        notify(new Error(event.state.message || "포트 포워딩에 실패했습니다."));
      } else if (event.kind === "document") {
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
      ![
        "home",
        "activity",
        "hosts",
        "files",
        "settings",
        "workspaceTemplates",
      ].includes(active) &&
      !boot.document.workspaces.some(
        (w) => w.id === active && boot.workspaceOwners[w.id] === boot.windowId,
      )
    )
      setActive(
        boot.document.workspaces
          .filter((w) => boot.workspaceOwners[w.id] === boot.windowId)
          .at(-1)?.id ?? "home",
      );
  }, [boot?.document.workspaces, boot?.workspaceOwners]);
  useEffect(() => {
    if (!boot?.document.workspaces.some((w) => w.id === active)) return;
    try {
      localStorage.setItem(
        "passport-selection",
        JSON.stringify({ workspace: active, pane: activePane }),
      );
    } catch {
      /* storage can be unavailable */
    }
  }, [active, activePane]);
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
    if (bootRef.current)
      host = connectionHost(
        bootRef.current.document,
        host,
        bootRef.current.profiles,
        sftp,
      );
    const authId =
      sftp && (host.protocol === "ssh" || host.protocol === "sftp")
        ? (host.sftpAuthId ?? host.authId)
        : host.authId;
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
      await connectPane(paneId, host.id);
    }
  };
  const deliverPaste = (text: string, ids: string[]) => {
    const failures: string[] = [];
    for (const id of [...new Set(ids)]) {
      const entry = terminals.get(id);
      try {
        if (!entry?.connected) throw new Error("연결된 터미널이 없습니다.");
        const prepared = preparePaste(
          text,
          entry.term.modes.bracketedPasteMode,
        );
        entry.pasting = true;
        try {
          entry.term.paste(prepared);
        } finally {
          entry.pasting = false;
        }
      } catch (error) {
        failures.push(message(error));
      }
    }
    if (failures.length) notify(new Error([...new Set(failures)].join("\n")));
    terminals.get(activePane)?.term.focus();
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
      deliverPaste(interpolate(text, values), connected);
    })();
  };
  useEffect(() => {
    configureTerminals(deliverPaste, notify);
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const shortcuts = bootRef.current?.document.settings.shortcuts;
      if (!shortcuts) return;
      const mac = bootRef.current?.platform === "darwin";
      if (shortcutMatch(e, shortcuts.newTab, mac)) {
        e.preventDefault();
        e.stopPropagation();
        void openLocalTerminal();
        return;
      }
      if (shortcutMatch(e, shortcuts.activity, mac)) {
        e.preventDefault();
        e.stopPropagation();
        setActive("activity");
        return;
      }
      if (shortcutMatch(e, shortcuts.recentActivity, mac)) {
        e.preventDefault();
        e.stopPropagation();
        void api
          .call("activity.list", undefined)
          .then(async (items) => {
            for (const item of items.filter((i) => !i.read)) {
              try {
                await api.call("activity.open", { id: item.id });
                return;
              } catch {
                /* closed terminal: try next unread */
              }
            }
            notify("이동할 수 있는 미확인 터미널이 없습니다.");
          })
          .catch(notify);
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
  useEffect(() => {
    const focus = () => {
      const owned = bootRef.current?.document.workspaces.find(
        (w) =>
          w.id === active &&
          bootRef.current?.workspaceOwners[w.id] === bootRef.current?.windowId,
      );
      void api
        .call("activity.focus", {
          paneId:
            document.hasFocus() &&
            owned &&
            !document.querySelector('[role="dialog"]')
              ? activePane || null
              : null,
        })
        .catch(() => {});
    };
    focus();
    window.addEventListener("focus", focus);
    window.addEventListener("blur", focus);
    window.addEventListener("focusin", focus);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", focus);
      window.removeEventListener("focusin", focus);
    };
  }, [active, activePane, templateEditor, requests.length]);
  useEffect(() => {
    if (!activation) return;
    let activated = false;
    const activate = () => {
      if (activated || document.querySelector('[role="dialog"]')) return;
      activated = true;
      setActive(activation.workspaceId);
      setActivePane(activation.paneId);
      setActivation(null);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          window.dispatchEvent(
            new CustomEvent("passport-activate", { detail: activation.paneId }),
          );
          requestAnimationFrame(() =>
            terminals.get(activation.paneId)?.term.focus(),
          );
        }),
      );
    };
    const observer = new MutationObserver(activate);
    observer.observe(document.body, { childList: true, subtree: true });
    activate();
    return () => observer.disconnect();
  }, [activation]);
  useEffect(() => {
    if (!localFocus) return;
    if (active !== localFocus.workspaceId) {
      setLocalFocus(null);
      return;
    }
    // Focus after React has committed the visible pane and its xterm mount.
    // An IPC reply can arrive before that commit; a frame scheduled from the
    // connection promise alone may run while the terminal is still detached.
    const entry = terminals.get(localFocus.paneId);
    if (!entry?.term.element?.isConnected) return;
    const frame = requestAnimationFrame(() => {
      if (
        document.hasFocus() &&
        entry.term.element?.offsetParent &&
        !document.querySelector('[role="dialog"]')
      )
        entry.term.focus();
      setLocalFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [localFocus, active, boot?.document, boot?.workspaceOwners]);
  const openLocalTerminal = async () => {
    const current = bootRef.current;
    if (!current) return;
    const id = uuid(),
      paneId = uuid();
    const ok = await update((d) => {
      if (d.workspaces.flatMap((w) => panes(w.root)).length >= 32)
        throw new Error(
          "전체 터미널은 최대 32개입니다. 사용하지 않는 탭을 닫아 주세요.",
        );
      return {
        ...d,
        workspaces: [
          ...d.workspaces,
          {
            id,
            name: "로컬 터미널",
            project: { cwd: current.home },
            root: {
              kind: "pane",
              id: paneId,
              hostId: LOCAL_HOST_ID,
              local: {
                shell: d.settings.terminal.shell,
                cwd: current.home,
                profiles: { mode: "inherit", ids: [] },
              },
            },
          },
        ],
      };
    });
    if (ok) {
      setActive(id);
      setActivePane(paneId);
      setLocalFocus({ workspaceId: id, paneId });
      await connectPane(paneId, LOCAL_HOST_ID);
    }
  };
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
        `${w.name}: 로컬 세션 ${panes(w.root).filter((p) => p.local && ["connected", "connecting"].includes(states[p.id]?.status)).length}개 · SSH 연결 ${panes(w.root).filter((p) => !p.local && ["connected", "connecting"].includes(states[p.id]?.status)).length}개를 종료할까요?`,
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
        <img
          src={icon}
          alt=""
          className={bootIconReady ? "ready" : undefined}
          onLoad={() => setBootIconReady(true)}
        />
        <h1>Passport를 시작할 수 없습니다.</h1>
        <p>{fatal}</p>
        <button onClick={() => location.reload()}>다시 시도</button>
      </div>
    );
  if (!boot)
    return (
      <div className="boot-screen">
        <img
          src={icon}
          alt=""
          className={bootIconReady ? "ready" : undefined}
          onLoad={() => setBootIconReady(true)}
        />
        <h1>Passport</h1>
        <p>작업 공간을 준비하고 있습니다.</p>
      </div>
    );
  return (
    <AppContext.Provider
      value={{
        boot,
        activities,
        document: boot.document,
        update,
        refresh,
        notify,
        ask,
        confirm,
        credentials,
        openHost,
        connectPane,
        saveTemplate: (workspaceId, templateId) =>
          setTemplateEditor({ workspaceId, templateId }),
        active,
        settingsSection,
        openSettings: (section) => {
          setSettingsSection(section);
          setActive("settings");
        },
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
      <div
        className={`app ${boot.platform === "darwin" ? "mac" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      >
        <header className="app-titlebar">
          <div className="brand">
            <img src={icon} alt="" />
            <span>Passport</span>
          </div>
          <IconButton
            label={sidebarCollapsed ? "작업 목록 펼치기" : "작업 목록 접기"}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <PanelLeft size={17} />
          </IconButton>
          <span className="window-caption">
            {boot.document.workspaces.find((w) => w.id === active)?.name ||
              "로컬 AI · SSH 작업 공간"}
          </span>
          <button
            className={`activity-button ${active === "activity" ? "active" : ""}`}
            aria-label="알림함"
            onClick={() => setActive("activity")}
          >
            <Bell size={17} />
            {activities.filter((a) => !a.read).length > 0 && (
              <small>{activities.filter((a) => !a.read).length}</small>
            )}
          </button>

          <IconButton
            label="설정"
            className={active === "settings" ? "active" : ""}
            onClick={() => setActive("settings")}
          >
            <SettingsIcon size={18} />
          </IconButton>
        </header>
        <aside className="workspace-sidebar">
          {" "}
          <nav className="tabs" aria-label="작업 목록">
            <button
              className={`app-tab fixed ${active === "home" ? "active" : ""}`}
              onClick={() => setActive("home")}
            >
              <House size={15} />
              시작
            </button>
            <button
              className={`app-tab fixed ${active === "hosts" ? "active" : ""}`}
              onClick={() => setActive("hosts")}
            >
              <Server size={15} />
              호스트
            </button>
            <button
              className={`app-tab fixed ${active === "workspaceTemplates" ? "active" : ""}`}
              onClick={() => setActive("workspaceTemplates")}
            >
              <Layers size={15} />
              템플릿
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
                    if (w.root.kind === "split")
                      e.dataTransfer.setData(dragGroupMime, "1");
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
                    {activities.some(
                      (a) =>
                        !a.read && panes(w.root).some((p) => p.id === a.paneId),
                    ) && (
                      <i className="unread-dot" aria-label="읽지 않은 알림" />
                    )}
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
            <IconButton
              label="새 로컬 터미널"
              onClick={() => void openLocalTerminal()}
            >
              <Plus size={18} />
            </IconButton>
          </nav>
        </aside>
        <main className="app-main">
          <div className="view home-view" hidden={active !== "home"}>
            <div className="home-intro">
              <img src={icon} alt="" />
              <h1>한 작업 공간에서 로컬 AI와 SSH를 함께</h1>
              <p>
                프로젝트에서 AI 작업을 시작하고, 옆 패널에 서버를 연결하세요.
              </p>
            </div>
            <div className="home-actions">
              {(
                [
                  ["local", "로컬 터미널", "선택한 셸로 프로젝트 작업"],
                  ["ssh", "SSH 연결", "저장한 서버에 연결"],
                ] as const
              ).map(([kind, label, detail]) => (
                <button
                  key={kind}
                  onClick={() => {
                    if (kind === "local") void openLocalTerminal();
                    else setActive("hosts");
                  }}
                >
                  <TerminalIcon size={22} />
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </button>
              ))}
            </div>
            <div className="row">
              <button onClick={() => setActive("workspaceTemplates")}>
                템플릿 불러오기
              </button>
              <button
                onClick={() => {
                  setSettingsSection("terminal");
                  setActive("settings");
                }}
              >
                터미널 기본 설정
              </button>
            </div>
            <p className="hint">
              저장한 배치는 자동 실행하지 않습니다. 왼쪽 작업을 선택해 필요한
              터미널을 시작하세요.
            </p>
          </div>
          <div className="view" hidden={active !== "activity"}>
            <ActivityView />
          </div>
          <div className="view" hidden={active !== "hosts"}>
            <Hosts />
          </div>
          <div className="view" hidden={active !== "files"}>
            <FilesView />
          </div>
          <div className="view" hidden={active !== "settings"}>
            <Settings />
          </div>
          <div className="view" hidden={active !== "workspaceTemplates"}>
            <WorkspaceTemplates />
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
            <span>
              로컬{" "}
              {
                boot.document.workspaces
                  .flatMap((w) => panes(w.root))
                  .filter(
                    (p) => p.local && states[p.id]?.status === "connected",
                  ).length
              }{" "}
              · SSH{" "}
              {
                boot.document.workspaces
                  .flatMap((w) => panes(w.root))
                  .filter(
                    (p) => !p.local && states[p.id]?.status === "connected",
                  ).length
              }{" "}
              연결
            </span>
          </div>
          <div>
            {jobs.some((j) => j.state === "running") && (
              <span>
                {jobs.filter((j) => j.state === "running").length}개 전송 중
              </span>
            )}
            <span>Passport {boot.appVersion}</span>
            {boot.updateState.status === "available" && (
              <button
                type="button"
                className="update-notice"
                onClick={() => {
                  setSettingsSection("about");
                  setActive("settings");
                }}
              >
                <Download size={12} />새 버전 {boot.updateState.latestVersion}
              </button>
            )}
          </div>
        </footer>
        <Tooltips />
        {toast && (
          <div
            className={`toast ${toast.error ? "error" : ""}`}
            role={toast.error ? "alert" : "status"}
          >
            <Info size={16} />
            <span>{toast.text}</span>
            <IconButton label="알림 닫기" onClick={() => setToast(null)}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        {templateEditor && (
          <TemplateEditor
            {...templateEditor}
            onClose={() => setTemplateEditor(null)}
          />
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
