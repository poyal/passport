import { useEffect, useState, type ReactNode } from "react";
import { FolderOpen, Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import type { LocalShell, Pane } from "../shared/model";
import {
  builtinProfiles,
  startupProfileSchema,
  type ProfileSelection,
  type StartupProfile,
  type ShellId,
  type AppliedEnvironment,
  type ProfileEntry,
} from "../shared/terminal-config";
import { LOCAL_HOST_ID } from "../shared/advanced";
import { api, uuid } from "./api";
import { useApp } from "./context";
import { IconButton, Modal, ToggleField } from "./components";

export type TerminalChoice = Pick<Pane, "hostId" | "local">;
function actualShell(id: ShellId, executable?: string): ShellId {
  if (id !== "default" && id !== "powershell") return id;
  const name = executable
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/\.exe$/, "");
  return name === "powershell"
    ? "windows-powershell"
    : name === "pwsh"
      ? "pwsh"
      : name === "bash"
        ? "bash"
        : "zsh";
}
export function ProfileSelector({
  value,
  onChange,
  shell,
  inherit = true,
  inherited,
}: {
  value?: ProfileSelection;
  onChange: (value: ProfileSelection) => void;
  shell: ShellId;
  inherit?: boolean;
  inherited?: ProfileSelection;
}) {
  const app = useApp();
  const selection = value || { mode: "inherit", ids: [] };
  const profiles = [
    ...builtinProfiles,
    ...app.document.settings.terminal.profiles,
  ];
  const resolved = actualShell(
    shell,
    app.boot.shells.find((s) => s.id === shell)?.path,
  );
  const selected =
    selection.mode === "custom"
      ? selection.ids
      : selection.mode === "none"
        ? []
        : inherited?.mode === "custom"
          ? inherited.ids
          : inherited?.mode === "none"
            ? []
            : app.document.settings.terminal.profileIds;
  const move = (index: number, offset: number) => {
    const ids = [...selected];
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    onChange({ mode: "custom", ids });
  };
  const notifications = app.document.settings.notifications;
  return (
    <div className="profile-selector">
      <label>
        시작 프로파일
        <select
          aria-label="시작 프로파일"
          value={selection.mode}
          onChange={(e) =>
            onChange({
              mode: e.target.value as ProfileSelection["mode"],
              ids: selected,
            })
          }
        >
          {inherit && <option value="inherit">상위 설정 상속</option>}
          <option value="none">사용 안 함</option>
          <option value="custom">직접 선택 (여러 개)</option>
        </select>
      </label>
      {selection.mode === "inherit" && (
        <p className="hint">
          작업별 설정이 있으면 우선 적용하고, 없으면 앱 기본값을 사용합니다.
        </p>
      )}
      {selected.includes("ai-notifications") && (
        <div className="info-banner notification-profile-status" role="status">
          <p>
            Claude 알림 {notifications.claude ? "켜짐" : "꺼짐"} · Codex 알림{" "}
            {notifications.codex ? "켜짐" : "꺼짐"}
          </p>
          {!notifications.claude && !notifications.codex ? (
            <p>프로파일만 선택된 상태입니다. 아래에서 받을 AI 알림을 켜세요.</p>
          ) : (
            <p>
              새로 여는 터미널부터 연결됩니다. 이미 열린 터미널은 다시 열어야
              합니다.
            </p>
          )}
          {(["claude", "codex"] as const).map((agent) => (
            <ToggleField
              key={agent}
              label={`${agent === "claude" ? "Claude Code" : "Codex"} 알림 연동`}
              checked={notifications[agent]}
              onChange={(enabled) =>
                void app.update((d) => ({
                  ...d,
                  settings: {
                    ...d.settings,
                    notifications: {
                      ...d.settings.notifications,
                      [agent]: enabled,
                    },
                  },
                }))
              }
            />
          ))}
        </div>
      )}
      {selection.mode === "custom" &&
        profiles.map((p) => {
          const compatible =
            p.shells.includes(resolved) &&
            p.platforms.includes(app.boot.platform as "darwin");
          return (
            <label className="check-label" key={p.id}>
              <input
                type="checkbox"
                checked={selected.includes(p.id)}
                disabled={!compatible && !selected.includes(p.id)}
                onChange={(e) =>
                  onChange({
                    mode: "custom",
                    ids: e.target.checked
                      ? [...selected, p.id]
                      : selected.filter((id) => id !== p.id),
                  })
                }
              />
              {p.name}
              <small>
                {compatible
                  ? `v${p.revision} · ${p.origin === "builtin" ? "앱 제공" : "사용자"}`
                  : "선택한 셸에서 지원 안 함"}
              </small>
            </label>
          );
        })}
      {!!selected.length && (
        <ol className="profile-order">
          {selected.map((id, index) => {
            const p = profiles.find((p) => p.id === id);
            return (
              <li key={id}>
                <details>
                  <summary>
                    {p?.name || id} <small>v{p?.revision}</small>
                  </summary>
                  {p?.integration ? (
                    <p>
                      설정에서 허용한 Claude/Codex에만 세션 알림을 연결합니다.
                    </p>
                  ) : (
                    p?.entries.map((entry, n) => (
                      <div className="profile-entry-preview" key={n}>
                        <code>
                          {entry.kind === "alias"
                            ? `${entry.name} → ${entry.command} ${entry.args.join(" ")}`
                            : entry.kind === "env"
                              ? `${entry.name}=${entry.value}`
                              : `PATH ${entry.position === "prepend" ? "앞" : "뒤"} + ${entry.value}`}
                        </code>
                        <small>
                          {entry.kind !== "path" && entry.overwrite
                            ? "충돌 시 덮어쓰기"
                            : "기존 값·명령 보존"}
                        </small>
                      </div>
                    ))
                  )}
                </details>
                {selection.mode === "custom" && (
                  <div className="row">
                    <IconButton
                      label={`${p?.name} 위로`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp size={13} />
                    </IconButton>
                    <IconButton
                      label={`${p?.name} 아래로`}
                      disabled={index === selected.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown size={13} />
                    </IconButton>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
export function TerminalChooser({
  onClose,
  onSelect,
  initial = "local",
  initialLocal,
  workspaceId,
  children,
  title = "새 터미널",
}: {
  onClose: () => void;
  onSelect: (choice: TerminalChoice) => Promise<void>;
  initial?: "local" | "ssh";
  initialLocal?: LocalShell;
  workspaceId?: string;
  children?: ReactNode;
  title?: string;
}) {
  const app = useApp();
  const workspace = app.document.workspaces.find((w) => w.id === workspaceId);
  const [kind, setKind] = useState(initialLocal ? "local" : initial);
  const [local, setLocal] = useState<LocalShell>(
    initialLocal
      ? { ...initialLocal, agent: undefined, needsReview: false }
      : {
          shell: app.document.settings.terminal.shell,
          cwd: workspace?.project?.cwd || "",
          profiles: { mode: "inherit", ids: [] },
        },
  );
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<AppliedEnvironment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (kind !== "ssh")
      void api
        .call("terminal.preview", { local, workspaceId })
        .then((p) => {
          if (!cancelled) {
            setPreview(p);
            setError("");
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setError(String(e.message));
            setPreview(null);
          }
        });
    return () => {
      cancelled = true;
    };
  }, [local, workspaceId, kind, app.document.settings.terminal]);
  const submit = async (choice: TerminalChoice) => {
    setBusy(true);
    try {
      await onSelect(choice);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} className="terminal-chooser-modal">
      {children}
      <div className="segmented" role="group" aria-label="터미널 종류">
        {(
          [
            ["local", "로컬"],
            ["ssh", "SSH"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={kind === id}
            onClick={() => setKind(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === "ssh" ? (
        <>
          <label>
            연결할 호스트 검색
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="이름 또는 주소"
            />
          </label>
          <div className="connection-chooser">
            {app.document.hosts
              .filter(
                (h) =>
                  h.protocol === "ssh" &&
                  `${h.name} ${h.address}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
              )
              .map((h) => (
                <button
                  key={h.id}
                  disabled={busy}
                  onClick={() => void submit({ hostId: h.id })}
                >
                  <strong>{h.name}</strong>
                  <small>
                    {h.username}@{h.address}:{h.port}
                  </small>
                </button>
              ))}
          </div>
          <button
            onClick={() => {
              onClose();
              app.setActive("hosts");
            }}
          >
            호스트 관리
          </button>
        </>
      ) : (
        <>
          <p className="hint">
            열린 터미널에서 <code>claude</code> 또는 <code>codex</code>를 입력해
            설치된 AI 도구를 실행할 수 있습니다.
          </p>
          {initialLocal?.needsReview && (
            <p className="info-banner">
              가져온 설정입니다. 이 기기의 폴더·셸과 아래 프로파일 내용을
              확인하세요.
            </p>
          )}
          <label>
            실행 셸
            <select
              aria-label="실행 셸"
              id="local-shell"
              value={local.shell}
              onChange={(e) =>
                setLocal({ ...local, shell: e.target.value as ShellId })
              }
            >
              {app.boot.shells.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.available}>
                  {s.name}
                  {s.available ? "" : ` · ${s.reason}`}
                </option>
              ))}
            </select>
          </label>
          <small className="path-caption">
            {app.boot.shells.find((s) => s.id === local.shell)?.path}
          </small>
          <label>
            프로젝트 폴더
            <div className="row">
              <input
                value={local.cwd}
                placeholder={workspace?.project?.cwd || app.boot.home}
                onChange={(e) => setLocal({ ...local, cwd: e.target.value })}
              />
              <IconButton
                label="프로젝트 폴더 선택"
                onClick={() =>
                  void api
                    .call("terminal.folder", undefined)
                    .then((cwd) => {
                      if (cwd) setLocal({ ...local, cwd });
                    })
                    .catch(app.notify)
                }
              >
                <FolderOpen size={16} />
              </IconButton>
            </div>
          </label>
          <ProfileSelector
            value={local.profiles}
            inherited={workspace?.project?.profiles}
            onChange={(profiles) => setLocal({ ...local, profiles })}
            shell={local.shell}
          />
          {preview && (
            <details>
              <summary>적용 순서와 충돌 미리보기</summary>
              <p className="path-caption">{preview.cwd}</p>
              {preview.results.length ? (
                preview.results.map((r, i) => (
                  <p key={i} className="hint">
                    {r}
                  </p>
                ))
              ) : (
                <p className="hint">추가 항목 없음</p>
              )}
              <p className="hint">
                사용자 셸 초기화 후 적용합니다. 기존 값과의 충돌 결과는 터미널의
                ‘실행 환경’에서 확인할 수 있습니다.
              </p>
            </details>
          )}
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button onClick={onClose}>취소</button>
            <button
              className="primary"
              disabled={busy || !!error || !preview}
              onClick={() =>
                void submit({
                  hostId: LOCAL_HOST_ID,
                  local: {
                    ...local,
                    agent: undefined,
                    needsReview: false,
                  },
                })
              }
            >
              {initialLocal ? "확인 후 새로 시작" : "로컬 터미널 열기"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
export function TerminalSettings() {
  const app = useApp();
  const settings = app.document.settings.terminal;
  const [preview, setPreview] = useState<AppliedEnvironment | null>(null);
  const [previewError, setPreviewError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api
      .call("terminal.preview", {
        local: {
          shell: settings.shell,
          cwd: app.boot.home,
          profiles: { mode: "inherit", ids: [] },
        },
      })
      .then((value) => {
        if (!cancelled) {
          setPreview(value);
          setPreviewError("");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(String(error.message));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settings, app.boot.home]);
  const [profileIds, setProfileIds] = useState(settings.profileIds);
  useEffect(() => setProfileIds(settings.profileIds), [settings.profileIds]);
  const [profileMode, setProfileMode] = useState<"none" | "custom">(
    settings.profileIds.length ? "custom" : "none",
  );
  const [editing, setEditing] = useState<StartupProfile | null>(null);
  const save = (patch: Partial<typeof settings>) =>
    app.update((d) => ({
      ...d,
      settings: {
        ...d.settings,
        terminal: { ...d.settings.terminal, ...patch },
      },
    }));
  return (
    <div className="settings-stack">
      <div className="page-heading">
        <div>
          <h2>로컬 터미널</h2>
          <p>기본 셸과 새 세션에 적용할 시작 환경을 선택합니다.</p>
        </div>
      </div>
      <section className="settings-card">
        <h3>기본 실행 환경</h3>
        <label>
          기본 셸
          <select
            aria-label="기본 셸"
            value={settings.shell}
            onChange={(e) => void save({ shell: e.target.value as ShellId })}
          >
            {app.boot.shells.map((s) => (
              <option key={s.id} value={s.id} disabled={!s.available}>
                {s.name}
                {s.available ? "" : " · 사용 불가"}
              </option>
            ))}
          </select>
        </label>
        {app.boot.shells.map((s) => (
          <p className="path-caption" key={s.id}>
            {s.name} · {s.architecture} · {s.path}
            {s.reason && ` · ${s.reason}`}
          </p>
        ))}
        <p className="hint">
          {app.boot.platform === "win32"
            ? "Bash 문법과 sh·Unix 도구는 Passport Bash에서 제공합니다. cmd와 PowerShell은 각 셸의 문법을 유지합니다."
            : "macOS 기본 셸의 사용자 시작 파일을 이어 읽습니다. 추가 프로파일은 앱이 관리하는 세션에만 적용합니다."}
        </p>
      </section>
      <section className="settings-card">
        <h3>기본 시작 프로파일</h3>
        <ProfileSelector
          value={{ mode: profileMode, ids: profileIds }}
          inherit={false}
          shell={settings.shell}
          onChange={(v) => {
            setProfileMode(v.mode === "none" ? "none" : "custom");
            const ids = v.mode === "none" ? [] : v.ids;
            setProfileIds(ids);
            if (JSON.stringify(ids) !== JSON.stringify(settings.profileIds))
              void save({ profileIds: ids });
          }}
        />
        <p className="hint">
          아래 순서대로 적용합니다. 변경은 새로 여는 터미널부터 적용됩니다.
        </p>
        <details>
          <summary>적용 순서와 충돌 미리보기</summary>
          {previewError && (
            <p role="alert" className="error-text">
              {previewError}
            </p>
          )}
          {preview && (
            <>
              <p className="path-caption">{preview.cwd}</p>
              {preview.results.length ? (
                preview.results.map((result, index) => (
                  <p className="hint" key={index}>
                    {result}
                  </p>
                ))
              ) : (
                <p className="hint">추가 항목 없음</p>
              )}
              <p className="hint">
                사용자 셸 초기화 후 적용합니다. 실제 적용 결과는 터미널의 ‘실행
                환경’에서 확인할 수 있습니다.
              </p>
            </>
          )}
        </details>
      </section>
      <section className="settings-card">
        <div className="row">
          <h3>사용자 프로파일</h3>
          <button
            onClick={() =>
              setEditing({
                id: uuid(),
                name: "새 프로파일",
                revision: 1,
                origin: "user",
                platforms: [app.boot.platform as "darwin"],
                shells: [
                  actualShell(
                    settings.shell,
                    app.boot.shells.find((s) => s.id === settings.shell)?.path,
                  ),
                ],
                entries: [],
              })
            }
          >
            <Plus size={14} />
            추가
          </button>
        </div>
        {settings.profiles.map((p) => (
          <div className="profile-row" key={p.id}>
            <div>
              <strong>{p.name}</strong>
              <small>
                v{p.revision} · {p.entries.length}개 항목
              </small>
            </div>
            <button onClick={() => setEditing(structuredClone(p))}>편집</button>
            <IconButton
              label={`${p.name} 삭제`}
              onClick={() =>
                void save({
                  profiles: settings.profiles.filter((x) => x.id !== p.id),
                  profileIds: settings.profileIds.filter((id) => id !== p.id),
                })
              }
            >
              <Trash2 size={15} />
            </IconButton>
          </div>
        ))}
        <p className="hint">
          작업이나 패널에서 사용 중인 프로파일은 선택을 해제한 뒤 삭제할 수
          있습니다. 환경 변수 값은 일반 설정에 저장되므로 비밀번호·토큰은 넣지
          마세요.
        </p>
      </section>
      <section className="settings-card">
        <ToggleField
          label="로컬 터미널 자동 로그 기록"
          checked={settings.autoLogLocal}
          onChange={(autoLogLocal) => void save({ autoLogLocal })}
        />
        <p className="hint">
          기본은 꺼짐입니다. SSH 자동 기록 설정은 세션 로그에서 관리합니다.
        </p>
      </section>
      {editing && (
        <ProfileEditor
          value={editing}
          onClose={() => setEditing(null)}
          onSave={async (p) => {
            const ok = await save({
              profiles: settings.profiles.some((x) => x.id === p.id)
                ? settings.profiles.map((x) =>
                    x.id === p.id ? { ...p, revision: x.revision + 1 } : x,
                  )
                : [...settings.profiles, p],
            });
            if (ok) setEditing(null);
          }}
        />
      )}
    </div>
  );
}
function ProfileEditor({
  value,
  onClose,
  onSave,
}: {
  value: StartupProfile;
  onClose: () => void;
  onSave: (p: StartupProfile) => Promise<void>;
}) {
  const [profile, setProfile] = useState(value),
    [error, setError] = useState("");
  const entry = (index: number, value: ProfileEntry) =>
    setProfile({
      ...profile,
      entries: profile.entries.map((e, i) => (i === index ? value : e)),
    });
  return (
    <Modal title="시작 프로파일 편집" onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = startupProfileSchema.safeParse(profile);
          if (!parsed.success) {
            setError(parsed.error.issues.map((i) => i.message).join(" · "));
            return;
          }
          void onSave(parsed.data);
        }}
      >
        <label>
          이름
          <input
            required
            value={profile.name}
            onChange={(e) => setProfile({ ...profile, name: e.target.value })}
          />
        </label>
        <div className="row">
          {(["darwin", "win32"] as const).map((p) => (
            <label className="check-label" key={p}>
              <input
                type="checkbox"
                checked={profile.platforms.includes(p)}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    platforms: e.target.checked
                      ? [...profile.platforms, p]
                      : profile.platforms.filter((x) => x !== p),
                  })
                }
              />
              {p === "darwin" ? "macOS" : "Windows"}
            </label>
          ))}
        </div>
        <div className="profile-shells">
          {(
            [
              "zsh",
              "bash",
              "passport-bash",
              "cmd",
              "windows-powershell",
              "pwsh",
            ] as ShellId[]
          ).map((s) => (
            <label className="check-label" key={s}>
              <input
                type="checkbox"
                checked={profile.shells.includes(s)}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    shells: e.target.checked
                      ? [...profile.shells, s]
                      : profile.shells.filter((x) => x !== s),
                  })
                }
              />
              {s}
            </label>
          ))}
        </div>
        {profile.entries.map((e, index) => (
          <div className="profile-edit-entry" key={index}>
            <div className="row">
              <strong>
                {index + 1}.{" "}
                {e.kind === "alias"
                  ? "단축 명령"
                  : e.kind === "env"
                    ? "환경 변수"
                    : "PATH"}
              </strong>
              <IconButton
                label="항목 삭제"
                onClick={() =>
                  setProfile({
                    ...profile,
                    entries: profile.entries.filter((_, i) => i !== index),
                  })
                }
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
            {e.kind !== "path" && (
              <label>
                이름
                <input
                  required
                  value={e.name}
                  onChange={(v) => entry(index, { ...e, name: v.target.value })}
                />
              </label>
            )}
            {e.kind === "alias" ? (
              <>
                <label>
                  실행 명령
                  <input
                    required
                    value={e.command}
                    onChange={(v) =>
                      entry(index, { ...e, command: v.target.value })
                    }
                  />
                </label>
                <label>
                  인자 (한 줄에 하나)
                  <textarea
                    value={e.args.join("\n")}
                    onChange={(v) =>
                      entry(index, {
                        ...e,
                        args: v.target.value ? v.target.value.split("\n") : [],
                      })
                    }
                  />
                </label>
              </>
            ) : (
              <label>
                {e.kind === "path" ? "추가 경로" : "값"}
                <input
                  value={e.value}
                  onChange={(v) =>
                    entry(index, { ...e, value: v.target.value })
                  }
                />
              </label>
            )}
            {e.kind === "path" ? (
              <label>
                추가 위치
                <select
                  value={e.position}
                  onChange={(v) =>
                    entry(index, {
                      ...e,
                      position: v.target.value as "prepend",
                    })
                  }
                >
                  <option value="prepend">앞에 추가</option>
                  <option value="append">뒤에 추가</option>
                </select>
              </label>
            ) : (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={e.overwrite}
                  onChange={(v) =>
                    entry(index, { ...e, overwrite: v.target.checked })
                  }
                />
                기존 항목 덮어쓰기
              </label>
            )}
          </div>
        ))}
        <div className="row">
          {(["alias", "env", "path"] as const).map((kind) => (
            <button
              type="button"
              key={kind}
              onClick={() =>
                setProfile({
                  ...profile,
                  entries: [
                    ...profile.entries,
                    kind === "alias"
                      ? {
                          kind,
                          name: "",
                          command: "",
                          args: [],
                          overwrite: false,
                        }
                      : kind === "env"
                        ? { kind, name: "", value: "", overwrite: false }
                        : { kind, value: "", position: "append" },
                  ],
                })
              }
            >
              <Plus size={14} />
              {kind}
            </button>
          ))}
        </div>
        <p className="hint">
          명령과 인자는 각각 입력하세요. 셸 스크립트·파이프·자동 실행 명령은 이
          프로파일에 포함하지 않습니다. cmd 단축 명령은 대화형 입력에서만
          동작합니다.
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button className="primary">저장</button>
        </div>
      </form>
    </Modal>
  );
}
