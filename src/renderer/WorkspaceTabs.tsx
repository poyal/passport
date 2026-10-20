import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Terminal,
  X,
  Pencil,
  CircleAlert,
  Server,
  Smile,
  Check,
} from "lucide-react";
import type {
  Workspace,
  PassportDocument,
  SessionState,
} from "../shared/model";
import { panes } from "../shared/layout";
import { hostOS, hostIconNames } from "../shared/host-os";
import {
  osIconKinds,
  localIconGroups,
  localIconNames,
  matchesLocalIcon,
  workspaceColors,
  workspaceIconSchema,
  workspaceColorSchema,
} from "../shared/workspace-style";
import { useApp } from "./context";
import { OSIcon } from "./HostIcon";
import { LocalIcon } from "./LocalIcon";
import { IconButton, Modal } from "./components";
import { dragMime, dragWorkspaceMime, startLayoutDrag } from "./Workspaces";

const emojiGroups = [
  {
    name: "개발·실험",
    items: [
      ["💻", "로컬 개발"],
      ["🖥️", "워크스테이션"],
      ["⌨️", "터미널"],
      ["🛠️", "개발 도구"],
      ["🔧", "수정"],
      ["⚙️", "설정"],
      ["🧪", "테스트"],
      ["🔬", "실험"],
      ["🧩", "모듈"],
      ["🐛", "디버깅"],
      ["🤖", "AI 에이전트"],
      ["🧠", "모델"],
    ],
  },
  {
    name: "서버·네트워크",
    items: [
      ["🌐", "웹"],
      ["☁️", "클라우드"],
      ["🛰️", "원격 서버"],
      ["📡", "네트워크"],
      ["🔌", "연결"],
      ["🔗", "연동"],
      ["🗄️", "데이터베이스"],
      ["💾", "저장소"],
      ["📂", "파일"],
      ["🐳", "컨테이너"],
      ["🕸️", "서비스망"],
      ["🐧", "Linux"],
    ],
  },
  {
    name: "배포·운영",
    items: [
      ["🚀", "배포"],
      ["📦", "패키지"],
      ["🏗️", "빌드"],
      ["🏭", "운영 서버"],
      ["🏠", "홈 서버"],
      ["🚦", "스테이징"],
      ["📊", "모니터링"],
      ["📈", "성능"],
      ["🔍", "조사"],
      ["📝", "로그"],
      ["📋", "작업 목록"],
      ["🧭", "프로젝트"],
    ],
  },
  {
    name: "보안·상태",
    items: [
      ["🔒", "보안"],
      ["🔐", "인증"],
      ["🔑", "접근 키"],
      ["🛡️", "보호"],
      ["🧯", "복구"],
      ["🚨", "장애 대응"],
      ["✅", "완료"],
      ["⚠️", "주의"],
      ["🔥", "긴급"],
      ["⚡", "빠른 작업"],
      ["⭐", "즐겨찾기"],
      ["🎯", "목표"],
    ],
  },
] as const;

function tabStyle(color?: string): CSSProperties {
  return color ? ({ "--tab-color": color } as CSSProperties) : {};
}
export function WorkspaceMark({
  workspace,
  document,
  sessionState,
}: {
  workspace: Workspace;
  document: PassportDocument;
  sessionState?: SessionState;
}) {
  const icon = workspace.icon;
  if (icon?.kind === "emoji")
    return (
      <span className="workspace-emoji" aria-label={`이모지 ${icon.value}`}>
        {icon.value}
      </span>
    );
  if (icon?.kind === "terminal")
    return <Terminal size={20} aria-label="로컬 터미널" />;
  if (icon?.kind === "os")
    return <OSIcon compact kind={icon.os} label={hostIconNames[icon.os]} />;
  if (icon?.kind === "local") return <LocalIcon kind={icon.local} />;
  const first = panes(workspace.root)[0];
  if (
    workspace.root.kind === "pane" &&
    first.local &&
    sessionState?.id === first.id &&
    sessionState.status === "connected" &&
    sessionState.activeAgent
  )
    return <LocalIcon kind={sessionState.activeAgent} />;
  if (first.local) return <Terminal size={20} aria-label="로컬 터미널" />;
  const host = document.hosts.find((h) => h.id === first.hostId);
  const os = host ? hostOS(host) : { kind: "server" as const, label: "서버" };
  return <OSIcon compact {...os} />;
}

export function WorkspaceTab({
  workspace: w,
  onEdit,
  onClose,
}: {
  workspace: Workspace;
  onEdit: () => void;
  onClose: () => void;
}) {
  const app = useApp(),
    button = useRef<HTMLButtonElement>(null),
    menuRef = useRef<HTMLDivElement>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => () => clearTimeout(hover.current), []);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector("button")?.focus();
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const dismiss = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [menu]);
  const all = panes(w.root),
    ids = new Set(all.map((p) => p.id));
  const pending = app.activities.some(
    (a) =>
      ids.has(a.paneId) &&
      a.available &&
      !a.resolved &&
      ["permission", "input", "failed"].includes(a.kind),
  );
  const unread = app.activities.some((a) => ids.has(a.paneId) && !a.read);
  const tooltip = `${w.name}\n${all.map((p) => (p.local ? "로컬 터미널" : app.document.hosts.find((h) => h.id === p.hostId)?.name || "서버")).join(" · ")}${pending ? "\n확인할 요청이 있습니다" : ""}`;
  const clearHover = () => {
    clearTimeout(hover.current);
    hover.current = undefined;
  };
  return (
    <div
      className={`app-tab workspace-tab ${app.active === w.id ? "active" : ""} ${w.color ? "colored" : ""}`}
      style={tabStyle(w.color)}
      draggable
      onDragStart={(e) => {
        setMenu(null);
        startLayoutDrag(e.dataTransfer, w.id, w.root);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({
          x: Math.min(e.clientX, window.innerWidth - 180),
          y: Math.min(e.clientY, window.innerHeight - 60),
        });
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(dragMime)) return;
        if (e.dataTransfer.types.includes(dragWorkspaceMime(w.id))) {
          e.dataTransfer.dropEffect = "none";
          clearHover();
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!hover.current)
          hover.current = setTimeout(() => {
            app.setActive(w.id);
            hover.current = undefined;
          }, 350);
      }}
      onDragLeave={clearHover}
      onDrop={(e) => {
        e.preventDefault();
        clearHover();
        try {
          const source = JSON.parse(e.dataTransfer.getData(dragMime)) as {
            workspace: string;
          };
          if (source.workspace === w.id) return;
          void app.update((d) => {
            const from = d.workspaces.findIndex(
                (x) => x.id === source.workspace,
              ),
              to = d.workspaces.findIndex((x) => x.id === w.id);
            if (from < 0 || to < 0) return d;
            const next = [...d.workspaces];
            next.splice(to, 0, next.splice(from, 1)[0]);
            return { ...d, workspaces: next };
          });
        } catch {
          /* foreign drag */
        }
      }}
    >
      <button
        ref={button}
        className="workspace-select"
        aria-label={w.name}
        aria-current={app.active === w.id ? "page" : undefined}
        data-tooltip={tooltip}
        onClick={() => {
          app.setActive(w.id);
          app.setActivePane(all[0].id);
        }}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({
              x: rect.left,
              y: Math.min(rect.bottom, window.innerHeight - 60),
            });
          }
        }}
      >
        <span className="workspace-mark">
          <WorkspaceMark
            workspace={w}
            document={app.document}
            sessionState={app.sessionStates[all[0].id]}
          />
          {all.length > 1 && (
            <small
              className="workspace-extra"
              aria-label={`추가 패널 ${all.length - 1}개`}
            >
              +{all.length - 1}
            </small>
          )}
          {pending ? (
            <CircleAlert
              className="workspace-attention"
              size={12}
              aria-label="확인할 요청"
            />
          ) : (
            unread && <i className="unread-dot" aria-label="읽지 않은 알림" />
          )}
        </span>
        <span className="workspace-name">{w.name}</span>
      </button>
      <IconButton
        className="workspace-close"
        label={`${w.name} 탭 닫기`}
        onClick={onClose}
      >
        <X size={13} />
      </IconButton>
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="작업 탭 메뉴"
          className="context-menu workspace-menu"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(e) => {
            if (["Escape", "Tab"].includes(e.key)) {
              e.preventDefault();
              setMenu(null);
              button.current?.focus();
            }
          }}
        >
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              button.current?.focus();
              onEdit();
            }}
          >
            <Pencil size={14} />탭 편집
          </button>
        </div>
      )}
    </div>
  );
}

export function WorkspaceEditor({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const app = useApp(),
    appRef = useRef(app);
  appRef.current = app;
  const workspace = app.document.workspaces.find((w) => w.id === id);
  const [name, setName] = useState(workspace?.name || ""),
    [icon, setIcon] = useState(workspace?.icon),
    [color, setColor] = useState(workspace?.color || ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [iconPanel, setIconPanel] = useState<"os" | "local" | "emoji">(() => {
    if (workspace?.icon?.kind === "emoji") return "emoji";
    if (
      workspace?.icon?.kind === "local" ||
      workspace?.icon?.kind === "terminal" ||
      (!workspace?.icon && workspace && panes(workspace.root)[0]?.local)
    )
      return "local";
    return "os";
  });
  const [customEmoji, setCustomEmoji] = useState(
    workspace?.icon?.kind === "emoji" ? workspace.icon.value : "",
  );
  const [iconSearch, setIconSearch] = useState("");
  const [localGroup, setLocalGroup] = useState("all");
  const localGroups = localIconGroups
    .filter((group) => localGroup === "all" || group.id === localGroup)
    .map((group) => ({
      ...group,
      kinds: group.kinds.filter((kind) => matchesLocalIcon(kind, iconSearch)),
    }))
    .filter((group) => group.kinds.length > 0);
  const validColor = workspaceColorSchema.safeParse(color);
  return (
    <Modal
      title="작업 탭 편집"
      className="workspace-editor"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          const parsedIcon = workspaceIconSchema.optional().safeParse(icon);
          if (!name.trim() || name.trim().length > 256) {
            setError("이름은 1~256자로 입력해 주세요.");
            return;
          }
          if (!parsedIcon.success) {
            setError("이모지를 한 개 입력해 주세요.");
            return;
          }
          if (color && !validColor.success) {
            setError("색상은 #RRGGBB 형식으로 입력해 주세요.");
            return;
          }
          setError("");
          setBusy(true);
          void app
            .update((d) => {
              if (
                !d.workspaces.some((w) => w.id === id) ||
                appRef.current.boot.workspaceOwners[id] !==
                  appRef.current.boot.windowId
              )
                throw new Error("탭이 닫혔거나 다른 창으로 이동했습니다.");
              return {
                ...d,
                workspaces: d.workspaces.map((w) =>
                  w.id === id
                    ? {
                        ...w,
                        name: name.trim(),
                        icon: parsedIcon.data,
                        color:
                          color && validColor.success
                            ? validColor.data
                            : undefined,
                      }
                    : w,
                ),
              };
            })
            .then((ok) => {
              if (ok) onClose();
            })
            .finally(() => setBusy(false));
        }}
      >
        <div className="workspace-editor-body">
          <label>
            이름
            <input
              aria-label="작업 탭 이름"
              value={name}
              maxLength={256}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className="workspace-icon-picker">
            <legend>아이콘</legend>
            <button
              type="button"
              className="workspace-icon-choice workspace-icon-auto"
              aria-label="자동 · 첫 번째 패널"
              aria-pressed={!icon}
              onClick={() => setIcon(undefined)}
            >
              <span aria-hidden="true">
                {workspace ? (
                  <WorkspaceMark
                    workspace={{ ...workspace, icon: undefined }}
                    document={app.document}
                    sessionState={
                      app.sessionStates[panes(workspace.root)[0].id]
                    }
                  />
                ) : (
                  <Terminal size={20} />
                )}
              </span>
              <span>
                자동{" "}
                <small>단일 로컬은 실행 중인 AI · 그 외 첫 번째 패널</small>
              </span>
              {!icon && (
                <Check
                  className="workspace-choice-check"
                  size={14}
                  aria-hidden="true"
                />
              )}
            </button>
            <div
              className="workspace-icon-modes"
              role="group"
              aria-label="아이콘 종류"
            >
              <button
                type="button"
                aria-pressed={iconPanel === "os"}
                onClick={() => setIconPanel("os")}
              >
                <Server size={15} aria-hidden="true" />
                운영체제
              </button>
              <button
                type="button"
                aria-pressed={iconPanel === "local"}
                onClick={() => setIconPanel("local")}
              >
                <Terminal size={15} aria-hidden="true" />
                로컬
              </button>
              <button
                type="button"
                aria-pressed={iconPanel === "emoji"}
                onClick={() => setIconPanel("emoji")}
              >
                <Smile size={15} aria-hidden="true" />
                이모지
              </button>
            </div>
            {iconPanel === "os" ? (
              <div
                className="workspace-icon-grid"
                role="group"
                aria-label="운영체제 아이콘"
              >
                <button
                  type="button"
                  className="workspace-icon-choice"
                  aria-label="터미널 아이콘"
                  aria-pressed={icon?.kind === "terminal"}
                  onClick={() => setIcon({ kind: "terminal" })}
                >
                  <Terminal size={22} aria-hidden="true" />
                  <span>터미널</span>
                  {icon?.kind === "terminal" && (
                    <Check
                      className="workspace-choice-check"
                      size={12}
                      aria-hidden="true"
                    />
                  )}
                </button>
                {osIconKinds.map((kind) => (
                  <button
                    type="button"
                    className="workspace-icon-choice"
                    key={kind}
                    aria-label={`${hostIconNames[kind]} 아이콘`}
                    aria-pressed={icon?.kind === "os" && icon.os === kind}
                    onClick={() => setIcon({ kind: "os", os: kind })}
                  >
                    <OSIcon compact kind={kind} />
                    <span>{hostIconNames[kind]}</span>
                    {icon?.kind === "os" && icon.os === kind && (
                      <Check
                        className="workspace-choice-check"
                        size={12}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                ))}
              </div>
            ) : iconPanel === "local" ? (
              <div className="workspace-local-picker">
                <div className="workspace-local-filters">
                  <input
                    type="search"
                    aria-label="로컬 아이콘 검색"
                    placeholder="아이콘 검색 · GPT, Docker, Python"
                    value={iconSearch}
                    onChange={(e) => setIconSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing)
                        e.preventDefault();
                    }}
                  />
                  <select
                    aria-label="로컬 아이콘 분류"
                    value={localGroup}
                    onChange={(e) => setLocalGroup(e.target.value)}
                  >
                    <option value="all">전체 분류</option>
                    {localIconGroups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </div>
                {localGroups.length === 0 && (
                  <p className="workspace-icon-heading" role="status">
                    일치하는 아이콘이 없습니다.
                  </p>
                )}
                {localGroups.map((group) => (
                  <div key={group.name} role="group" aria-label={group.name}>
                    <p className="workspace-icon-heading">{group.name}</p>
                    <div className="workspace-icon-grid">
                      {group.kinds.map((kind) => {
                        const selected =
                          kind === "terminal"
                            ? icon?.kind === "terminal"
                            : icon?.kind === "local" && icon.local === kind;
                        return (
                          <button
                            type="button"
                            className="workspace-icon-choice"
                            key={kind}
                            aria-label={`${localIconNames[kind]} 아이콘`}
                            aria-pressed={selected}
                            onClick={() =>
                              setIcon(
                                kind === "terminal"
                                  ? { kind: "terminal" }
                                  : { kind: "local", local: kind },
                              )
                            }
                          >
                            <LocalIcon kind={kind} />
                            <span>{localIconNames[kind]}</span>
                            {selected && (
                              <Check
                                className="workspace-choice-check"
                                size={12}
                                aria-hidden="true"
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="workspace-emoji-picker">
                {emojiGroups.map((group) => (
                  <div key={group.name} role="group" aria-label={group.name}>
                    <p className="workspace-emoji-heading">{group.name}</p>
                    <div className="workspace-emoji-grid">
                      {group.items.map(([value, label]) => (
                        <button
                          type="button"
                          className="workspace-icon-choice"
                          key={value}
                          aria-label={`이모지 ${value} · ${label}`}
                          data-tooltip={label}
                          aria-pressed={
                            icon?.kind === "emoji" && icon.value === value
                          }
                          onClick={() => {
                            setIcon({ kind: "emoji", value });
                            setCustomEmoji(value);
                          }}
                        >
                          <span className="workspace-emoji" aria-hidden="true">
                            {value}
                          </span>
                          {icon?.kind === "emoji" && icon.value === value && (
                            <Check
                              className="workspace-choice-check"
                              size={10}
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <label className="workspace-custom-emoji">
                  직접 입력
                  <input
                    aria-label="탭 이모지"
                    placeholder="원하는 이모지 한 개"
                    value={customEmoji}
                    maxLength={64}
                    onChange={(e) => {
                      setCustomEmoji(e.target.value);
                      setIcon({ kind: "emoji", value: e.target.value });
                    }}
                  />
                </label>
              </div>
            )}
          </fieldset>
          <fieldset>
            <legend>탭 색상</legend>
            <div className="workspace-swatches">
              {workspaceColors.map(([label, value]) => (
                <button
                  type="button"
                  key={value}
                  aria-label={`${label} 탭 색상`}
                  aria-pressed={color.toLowerCase() === value}
                  style={{ background: value }}
                  onClick={() => setColor(value)}
                />
              ))}
            </div>
            <div className="row">
              <input
                type="color"
                aria-label="탭 색상 선택"
                value={validColor.success ? validColor.data : "#3b82f6"}
                onChange={(e) => setColor(e.target.value)}
              />
              <input
                aria-label="탭 색상 HEX"
                placeholder="기본 색상"
                value={color}
                maxLength={7}
                onChange={(e) => setColor(e.target.value)}
              />
              <button type="button" onClick={() => setColor("")}>
                기본 색상
              </button>
            </div>
          </fieldset>
          {workspace && (
            <div
              className={`workspace-preview ${validColor.success ? "colored" : ""}`}
              style={tabStyle(validColor.success ? validColor.data : undefined)}
              aria-label="탭 미리보기"
            >
              <WorkspaceMark
                workspace={{ ...workspace, icon }}
                document={app.document}
                sessionState={app.sessionStates[panes(workspace.root)[0].id]}
              />
              <span>{name || "작업 탭"}</span>
            </div>
          )}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button className="primary" disabled={busy}>
            적용
          </button>
        </div>
      </form>
    </Modal>
  );
}
