import { useEffect, useRef, useState } from "react";
import {
  Plus,
  X,
  Play,
  Square,
  ArrowUpRight,
  Download,
  Trash2,
  Network,
} from "lucide-react";
import { useApp } from "./context";
import { api, uuid } from "./api";
import {
  Modal,
  IconButton,
  NumberField,
  Empty,
  SettingsTabs,
} from "./components";
import { panes } from "../shared/layout";
import {
  effectiveHost,
  connectionHost,
  interpolate,
  variables,
  executableCommand,
  validateShortcuts,
  paneHost,
} from "../shared/advanced";
import {
  customThemeSchema,
  tunnelSchema,
  type Host,
  type Group,
  type TunnelRule,
  type TunnelState,
  type Workspace,
  type LogFile,
  type CustomTheme,
  type CommandSuggestion,
  type Endpoint,
} from "../shared/model";
import { getTheme } from "../shared/themes";
import { setBroadcast } from "./terminals";

export function HostExtras({
  host,
  onChange,
}: {
  host: Host;
  onChange: (h: Host) => void;
}) {
  const app = useApp(),
    resolved = connectionHost(app.document, host, app.boot.profiles);
  const [environment, setEnvironment] = useState(
      JSON.stringify(host.environment, null, 2),
    ),
    [error, setError] = useState("");
  useEffect(
    () => setEnvironment(JSON.stringify(host.environment, null, 2)),
    [host.id],
  );
  return (
    <details className="advanced-details">
      <summary>상속 · 시작 명령 · 키 설정</summary>
      <p className="hint">
        가까운 상위 그룹의 설정을 사용합니다. 외형은 그룹 → 호스트 → 세션 순서로
        적용됩니다.
      </p>
      {(["port", "username", "authId"] as const).map((field, index) => (
        <label className="check-label" key={field}>
          <input
            type="checkbox"
            checked={host.inherit.includes(field)}
            onChange={(e) =>
              onChange({
                ...host,
                inherit: e.target.checked
                  ? [...host.inherit, field]
                  : host.inherit.filter((v) => v !== field),
              })
            }
          />
          {["포트", "사용자 이름", "인증 프로필"][index]} 그룹 설정 사용
        </label>
      ))}
      <p className="hint">
        실제 연결: {resolved.username}@{host.address}:{resolved.port}
      </p>
      <label>
        Backspace
        <select
          value={host.backspace}
          onChange={(e) =>
            onChange({
              ...host,
              backspace: e.target.value as Host["backspace"],
            })
          }
        >
          <option>DEL</option>
          <option>BS</option>
        </select>
      </label>
      <label>
        접속 시 시작 스니펫
        <select
          value={host.startupSnippetId || ""}
          onChange={(e) =>
            onChange({ ...host, startupSnippetId: e.target.value || null })
          }
        >
          <option value="">사용하지 않음</option>
          {app.document.snippets
            .filter((s) => !variables(s.content).length)
            .map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </label>
      <p className="hint">
        직접 새로 연결할 때 한 번 실행합니다. 자동 재접속에서는 실행하지
        않습니다.
      </p>
      <label>
        환경 변수 · JSON
        <textarea
          className="code"
          rows={5}
          value={environment}
          onChange={(e) => {
            setEnvironment(e.target.value);
            try {
              const value = JSON.parse(e.target.value);
              if (
                !value ||
                Array.isArray(value) ||
                typeof value !== "object" ||
                Object.values(value).some((v) => typeof v !== "string") ||
                Object.keys(value).some(
                  (k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k),
                )
              )
                throw new Error();
              e.target.setCustomValidity("");
              onChange({ ...host, environment: value });
              setError("");
            } catch {
              e.target.setCustomValidity(
                "문자열 값을 가진 JSON 객체로 입력하세요.",
              );
              setError("문자열 값을 가진 JSON 객체로 입력하세요.");
            }
          }}
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <p className="hint">
        서버의 AcceptEnv 정책에 따라 환경 변수가 거절될 수 있습니다.
      </p>
    </details>
  );
}
export function GroupDefaults({
  group,
  onClose,
}: {
  group: Group;
  onClose: () => void;
}) {
  const app = useApp(),
    [draft, setDraft] = useState(group.defaults);
  return (
    <Modal title={`${group.name} 그룹 기본값`} onClose={onClose}>
      <p className="hint">
        빈 항목은 상위 그룹 또는 호스트 기본값을 유지합니다.
      </p>
      <label>
        기본 포트
        <input
          type="number"
          min={1}
          max={65535}
          value={draft.port ?? ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              port: e.target.value ? Number(e.target.value) : undefined,
            })
          }
        />
      </label>
      <label>
        기본 사용자
        <input
          value={draft.username || ""}
          onChange={(e) =>
            setDraft({ ...draft, username: e.target.value || undefined })
          }
        />
      </label>
      <label>
        기본 인증 프로필
        <select
          value={draft.authId === undefined ? "inherit" : draft.authId || ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              authId:
                e.target.value === "inherit"
                  ? undefined
                  : e.target.value || null,
            })
          }
        >
          <option value="inherit">상위 그룹 사용</option>
          <option value="">연결할 때 입력</option>
          {app.boot.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        기본 테마
        <select
          value={draft.appearance?.theme || ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              appearance: {
                ...draft.appearance,
                theme: e.target.value || undefined,
              },
            })
          }
        >
          <option value="">상위 그룹 / 전체 기본값</option>
          {app.document.settings.customThemes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          {[
            "mocha",
            "one-dark",
            "dracula",
            "tokyo-night",
            "nord",
            "gruvbox-dark",
            "solarized-dark",
            "campbell",
            "basic",
            "latte",
            "gruvbox-light",
            "solarized-light",
          ].map((id) => (
            <option key={id} value={getTheme(id).id}>
              {getTheme(id).name}
            </option>
          ))}
        </select>
      </label>
      <div className="modal-actions">
        <button onClick={onClose}>취소</button>
        <button
          className="primary"
          onClick={() =>
            void app
              .update((d) => ({
                ...d,
                groups: d.groups.map((g) =>
                  g.id === group.id ? { ...g, defaults: draft } : g,
                ),
              }))
              .then((ok) => ok && onClose())
          }
        >
          그룹 기본값 저장
        </button>
      </div>
    </Modal>
  );
}
export function BulkHosts({
  ids,
  onClose,
}: {
  ids: string[];
  onClose: () => void;
}) {
  const app = useApp(),
    [fields, setFields] = useState<string[]>([]),
    [groupId, setGroup] = useState(""),
    [tags, setTags] = useState(""),
    [port, setPort] = useState(22),
    [authId, setAuth] = useState("");
  const toggle = (field: string) =>
    setFields((old) =>
      old.includes(field) ? old.filter((x) => x !== field) : [...old, field],
    );
  return (
    <Modal title={`호스트 ${ids.length}개 일괄 편집`} onClose={onClose}>
      <p className="hint">
        체크한 항목만 변경합니다. 포트와 인증을 지정하면 해당 항목의 그룹 상속을
        해제합니다.
      </p>
      <div className="bulk-fields">
        <div className="bulk-field">
          <label className="check-label">
            <input
              type="checkbox"
              checked={fields.includes("group")}
              onChange={() => toggle("group")}
            />
            그룹 변경
          </label>
          <select
            aria-label="일괄 그룹"
            disabled={!fields.includes("group")}
            value={groupId}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="">그룹 없음</option>
            {app.document.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <div className="bulk-field">
          <label className="check-label">
            <input
              type="checkbox"
              checked={fields.includes("tags")}
              onChange={() => toggle("tags")}
            />
            태그 교체
          </label>
          <input
            aria-label="일괄 태그"
            disabled={!fields.includes("tags")}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="개발, 빌드"
          />
        </div>
        <div className="bulk-field">
          <label className="check-label">
            <input
              type="checkbox"
              checked={fields.includes("port")}
              onChange={() => toggle("port")}
            />
            포트 변경
          </label>
          <input
            aria-label="일괄 포트"
            disabled={!fields.includes("port")}
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
          />
        </div>
        <div className="bulk-field">
          <label className="check-label">
            <input
              type="checkbox"
              checked={fields.includes("authId")}
              onChange={() => toggle("authId")}
            />
            인증 프로필 변경
          </label>
          <select
            aria-label="일괄 인증"
            disabled={!fields.includes("authId")}
            value={authId}
            onChange={(e) => setAuth(e.target.value)}
          >
            <option value="">연결할 때 입력</option>
            {app.boot.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>취소</button>
        <button
          disabled={!fields.length}
          className="primary"
          onClick={() =>
            void app
              .update((d) => ({
                ...d,
                hosts: d.hosts.map((h) =>
                  ids.includes(h.id)
                    ? {
                        ...h,
                        ...(fields.includes("group")
                          ? { groupId: groupId || null }
                          : {}),
                        ...(fields.includes("tags")
                          ? {
                              tags: [
                                ...new Set(
                                  tags
                                    .split(",")
                                    .map((t) => t.trim())
                                    .filter(Boolean),
                                ),
                              ],
                            }
                          : {}),
                        ...(fields.includes("port") ? { port } : {}),
                        ...(fields.includes("authId")
                          ? { authId: authId || null }
                          : {}),
                        inherit: h.inherit.filter((f) => !fields.includes(f)),
                      }
                    : h,
                ),
              }))
              .then((ok) => ok && onClose())
          }
        >
          선택 항목 적용
        </button>
      </div>
    </Modal>
  );
}
export function ExecuteCommand({
  text,
  ids,
  onClose,
}: {
  text: string;
  ids: string[];
  onClose: () => void;
}) {
  const app = useApp(),
    [template, setTemplate] = useState(text),
    [values, setValues] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false);
  const names = variables(template);
  let resolved = template;
  try {
    resolved = interpolate(
      template,
      Object.fromEntries(names.map((n) => [n, values[n] || ""])),
    );
  } catch {}
  return (
    <Modal title="명령 실행 미리보기" onClose={onClose}>
      <p className="hint">
        연결된 {ids.length}개 터미널에 아래 명령과 Enter를 보냅니다. 변수 값은
        입력한 텍스트로 치환됩니다.
      </p>
      <p>
        {ids
          .map((id) => {
            const p = app.document.workspaces
              .flatMap((w) => panes(w.root))
              .find((p) => p.id === id);
            return p ? paneHost(app.document, p, app.boot.profiles).name : id;
          })
          .join(" · ")}
      </p>
      <label>
        명령
        <textarea
          rows={5}
          className="code"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        />
      </label>
      {names.map((name) => (
        <label key={name}>
          {name}
          <input
            value={values[name] || ""}
            onChange={(e) => setValues({ ...values, [name]: e.target.value })}
          />
        </label>
      ))}
      <pre className="command-preview">{resolved}</pre>
      <div className="modal-actions">
        <button onClick={onClose}>취소</button>
        <button
          className="primary"
          disabled={busy || !ids.length}
          onClick={() => {
            setBusy(true);
            void Promise.resolve()
              .then(() =>
                api.call("session.execute", {
                  ids,
                  command: executableCommand(resolved),
                }),
              )
              .then(() => {
                app.notify("명령을 실행했습니다.");
                onClose();
              })
              .catch(app.notify)
              .finally(() => setBusy(false));
          }}
        >
          명령 실행
        </button>
      </div>
    </Modal>
  );
}
export function WorkspaceOperations({ workspace }: { workspace: Workspace }) {
  const app = useApp(),
    [broadcastIds, setIds] = useState<string[]>([]),
    [enabled, setEnabled] = useState(false),
    [command, setCommand] = useState(""),
    [query, setQuery] = useState(""),
    [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]),
    [execute, setExecute] = useState<{ text: string; ids: string[] } | null>(
      null,
    ),
    [logs, setLogs] = useState<LogFile[]>([]),
    [targets, setTargets] = useState<{ id: number; title: string }[]>([]),
    [targetWindow, setTarget] = useState(""),
    [sources, setSources] = useState<Endpoint[]>([]),
    [source, setSource] = useState(""),
    [sourcePath, setPath] = useState("");
  const selected = panes(workspace.root).find((p) => p.id === app.activePane),
    eligible = panes(workspace.root).filter(
      (p) => !p.local && app.sessionStates[p.id]?.status === "connected",
    );
  const reload = () =>
    void api.call("logs.list", undefined).then(setLogs).catch(app.notify);
  useEffect(() => {
    reload();
    void api.call("window.list", undefined).then(setTargets).catch(app.notify);
    void api
      .call("files.connections", undefined)
      .then(setSources)
      .catch(app.notify);
  }, []);
  useEffect(() => {
    setEnabled(false);
    setBroadcast([]);
  }, [app.active]);
  useEffect(() => {
    const ids = broadcastIds.filter((id) => eligible.some((p) => p.id === id));
    if (enabled && app.active === workspace.id) setBroadcast(ids);
    else setBroadcast([]);
    return () => setBroadcast([]);
  }, [
    enabled,
    broadcastIds.join(","),
    eligible.map((p) => p.id).join(","),
    app.active,
  ]);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        void api
          .call("command.suggest", {
            query,
            endpointId: source || undefined,
            path: source ? sourcePath : undefined,
          })
          .then(setSuggestions)
          .catch(app.notify),
      200,
    );
    return () => clearTimeout(timer);
  }, [query, source, sourcePath]);
  useEffect(reload, [
    app.sessionStates[selected?.id || ""]?.status,
    app.document.settings.autoLog,
  ]);
  const recording = logs.some(
    (l) => l.sessionId === selected?.id && l.recording,
  );
  return (
    <div className="tool-body">
      <h4>명령 제안</h4>
      <input
        aria-label="명령 제안 검색"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="스니펫 · 실행 이력 검색"
      />
      <details>
        <summary>파일 경로 제안</summary>
        <button
          onClick={() =>
            void api
              .call("files.connections", undefined)
              .then(setSources)
              .catch(app.notify)
          }
        >
          연결 목록 새로고침
        </button>
        <select
          aria-label="경로 제안 연결"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setPath(
              sources.find((s) => s.id === e.target.value)?.initialPath || "",
            );
          }}
        >
          <option value="">사용하지 않음</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          aria-label="제안 기준 경로"
          value={sourcePath}
          onChange={(e) => setPath(e.target.value)}
        />
        <small className="hint">
          파일 화면에서 연결한 패널의 지정 경로를 조회합니다.
        </small>
      </details>
      <div className="suggestions">
        {suggestions.map((s, i) => (
          <button key={i} onClick={() => setCommand(s.text)}>
            <small>
              {s.source === "snippet"
                ? "스니펫"
                : s.source === "path"
                  ? "경로"
                  : "실행 이력"}
            </small>
            <code>{s.text}</code>
          </button>
        ))}
      </div>
      <label>
        명령 작성
        <textarea
          rows={4}
          className="code"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
      </label>
      <div className="row">
        <button
          disabled={!selected}
          onClick={() => selected && app.paste(command, [selected.id])}
        >
          붙여넣기
        </button>
        <button
          disabled={!selected}
          onClick={() =>
            selected && setExecute({ text: command, ids: [selected.id] })
          }
        >
          실행 미리보기
        </button>
      </div>
      <div className="section-line" />
      <h4>동시 키보드 입력</h4>
      <p className="hint">
        선택한 SSH 터미널에 키 입력을 보냅니다. 탭을 바꾸거나 이 패널을 닫으면
        해제됩니다.
      </p>
      {eligible.map((p) => (
        <label className="check-label" key={p.id}>
          <input
            type="checkbox"
            checked={broadcastIds.includes(p.id)}
            onChange={(e) =>
              setIds(
                e.target.checked
                  ? [...broadcastIds, p.id]
                  : broadcastIds.filter((id) => id !== p.id),
              )
            }
          />
          {paneHost(app.document, p, app.boot.profiles).name}
        </label>
      ))}
      <button
        className={enabled ? "danger filled" : ""}
        disabled={!broadcastIds.length}
        onClick={() => setEnabled(!enabled)}
      >
        {enabled
          ? `동시 입력 켜짐 · ${broadcastIds.length}개 · 끄기`
          : "동시 입력 켜기"}
      </button>
      <div className="section-line" />
      <h4>현재 터미널 로그</h4>
      <p className="recording-status">
        <span className={`dot ${recording ? "" : "muted"}`} />
        {recording
          ? "이 터미널의 출력을 자동으로 기록 중입니다."
          : "현재 기록이 일시 중지되어 있습니다."}
      </p>
      <button
        disabled={!selected}
        onClick={() =>
          selected &&
          void api
            .call("logs.record", { id: selected.id, enabled: !recording })
            .then(reload)
            .catch(app.notify)
        }
      >
        {recording ? "기록 일시 중지" : "기록 다시 시작"}
      </button>
      <small className="hint">
        접속부터 자동 기록하며 최대 30일 보관합니다.
        <button
          className="text-button"
          onClick={() => app.openSettings("logs")}
        >
          로그 보기 및 보관 설정
        </button>
      </small>
      <div className="section-line" />
      <h4>작업 탭 창 이동</h4>
      <select
        aria-label="대상 앱 창"
        value={targetWindow}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="">새 앱 창</option>
        {targets
          .filter((w) => w.id !== app.boot.windowId)
          .map((w) => (
            <option key={w.id} value={w.id}>
              {w.title}
            </option>
          ))}
      </select>
      <button
        onClick={() =>
          void api
            .call("window.move", {
              workspaceId: workspace.id,
              target: targetWindow ? Number(targetWindow) : undefined,
            })
            .catch(app.notify)
        }
      >
        <ArrowUpRight size={15} />
        연결을 유지하며 이동
      </button>
      {execute && (
        <ExecuteCommand {...execute} onClose={() => setExecute(null)} />
      )}
    </div>
  );
}
export function TunnelSettings() {
  const app = useApp(),
    [draft, setDraft] = useState<TunnelRule | null>(null),
    [states, setStates] = useState<Record<string, TunnelState>>(
      Object.fromEntries(app.boot.tunnelStates.map((t) => [t.id, t])),
    );
  useEffect(
    () =>
      api.onEvent((e) => {
        if (e.kind === "tunnel")
          setStates((old) => ({ ...old, [e.state.id]: e.state }));
      }),
    [],
  );
  const start = async (rule: TunnelRule) => {
    const raw = app.document.hosts.find((h) => h.id === rule.hostId);
    if (!raw) return;
    const secret = await app.credentials(effectiveHost(app.document, raw));
    if (secret === null) return;
    const state = await api.call("tunnel.start", { id: rule.id, secret });
    setStates((old) => ({ ...old, [state.id]: state }));
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>포트 포워딩</h1>
          <p>규칙을 저장하고 필요할 때 직접 시작합니다.</p>
        </div>
        <button
          className="primary"
          onClick={() =>
            setDraft(
              tunnelSchema.parse({
                id: uuid(),
                name: "새 터널",
                hostId:
                  app.document.hosts.find((h) => h.protocol === "ssh")?.id ||
                  uuid(),
                kind: "local",
                bindPort: 8080,
              }),
            )
          }
        >
          <Plus size={15} />새 규칙
        </button>
      </div>
      {!app.document.tunnels.length && (
        <Empty
          icon={<Network size={28} />}
          title="저장된 규칙이 없습니다"
          description="새 규칙을 추가해 SSH 서버를 통한 포트 연결을 설정하세요."
        />
      )}
      <div className="settings-stack">
        {app.document.tunnels.map((rule) => (
          <section className="settings-card" key={rule.id}>
            <div className="row">
              <strong>{rule.name}</strong>
              <span className="pill">
                {
                  (
                    {
                      starting: "연결 중",
                      running: "실행 중",
                      stopped: "중지",
                      error: "오류",
                    } as const
                  )[states[rule.id]?.status || "stopped"]
                }
              </span>
            </div>
            <p>
              {rule.kind === "local"
                ? "로컬"
                : rule.kind === "remote"
                  ? "원격"
                  : "SOCKS5"}{" "}
              · {rule.bindAddress}:{rule.bindPort}
              {rule.kind !== "dynamic"
                ? ` → ${rule.targetAddress}:${rule.targetPort}`
                : ""}
            </p>
            {states[rule.id]?.message && (
              <p className="error-text">{states[rule.id].message}</p>
            )}
            <div className="row">
              <button
                onClick={() => void start(rule).catch(app.notify)}
                disabled={["running", "starting"].includes(
                  states[rule.id]?.status,
                )}
              >
                시작
              </button>
              <button
                onClick={() =>
                  void api
                    .call("tunnel.stop", { id: rule.id })
                    .catch(app.notify)
                }
              >
                중지
              </button>
              <button
                disabled={["running", "starting"].includes(
                  states[rule.id]?.status,
                )}
                onClick={() => setDraft(rule)}
              >
                편집
              </button>
              <button
                className="danger"
                onClick={() =>
                  void app
                    .confirm("터널 삭제", `${rule.name} 규칙을 삭제할까요?`)
                    .then(
                      (ok) =>
                        ok &&
                        app.update((d) => ({
                          ...d,
                          tunnels: d.tunnels.filter((t) => t.id !== rule.id),
                        })),
                    )
                }
              >
                삭제
              </button>
            </div>
          </section>
        ))}
      </div>
      {draft && (
        <Modal title="포트 포워딩 규칙" onClose={() => setDraft(null)}>
          <label>
            이름
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            SSH 호스트
            <select
              value={draft.hostId}
              onChange={(e) => setDraft({ ...draft, hostId: e.target.value })}
            >
              {app.document.hosts
                .filter((h) => h.protocol === "ssh")
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            방식
            <select
              value={draft.kind}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  kind: e.target.value as TunnelRule["kind"],
                })
              }
            >
              <option value="local">로컬</option>
              <option value="remote">원격</option>
              <option value="dynamic">동적 · SOCKS5</option>
            </select>
          </label>
          <label>
            바인딩 주소
            <input
              value={draft.bindAddress}
              onChange={(e) =>
                setDraft({ ...draft, bindAddress: e.target.value })
              }
            />
          </label>
          <label>
            바인딩 포트
            <input
              type="number"
              min={1}
              max={65535}
              value={draft.bindPort}
              onChange={(e) =>
                setDraft({ ...draft, bindPort: Number(e.target.value) })
              }
            />
          </label>
          {draft.kind !== "dynamic" && (
            <>
              <label>
                대상 주소
                <input
                  value={draft.targetAddress}
                  onChange={(e) =>
                    setDraft({ ...draft, targetAddress: e.target.value })
                  }
                />
              </label>
              <label>
                대상 포트
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.targetPort}
                  onChange={(e) =>
                    setDraft({ ...draft, targetPort: Number(e.target.value) })
                  }
                />
              </label>
            </>
          )}
          <div className="modal-actions">
            <button onClick={() => setDraft(null)}>취소</button>
            <button
              className="primary"
              onClick={() =>
                void app
                  .update((d) => ({
                    ...d,
                    tunnels: d.tunnels.some((t) => t.id === draft.id)
                      ? d.tunnels.map((t) => (t.id === draft.id ? draft : t))
                      : [...d.tunnels, draft],
                  }))
                  .then((ok) => ok && setDraft(null))
              }
            >
              규칙 저장
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function LogSettings() {
  const app = useApp(),
    [items, setItems] = useState<LogFile[]>([]),
    [selected, setSelected] = useState(""),
    [query, setQuery] = useState(""),
    [tab, setTab] = useState<"browse" | "retention">("browse"),
    [content, setContent] = useState({
      text: "",
      offset: 0,
      next: 0,
      matches: [] as number[],
    });
  const readRequest = useRef(0),
    readerRef = useRef<HTMLPreElement>(null);
  const refresh = () =>
    void api
      .call("logs.list", undefined)
      .then((next) => {
        setItems(next);
        if (selected && !next.some((item) => item.id === selected)) {
          readRequest.current++;
          setSelected("");
        }
      })
      .catch(app.notify);
  useEffect(refresh, []);
  useEffect(
    () => () => {
      readRequest.current++;
    },
    [],
  );
  const read = (id: string, offset = 0, search = query) => {
    const request = ++readRequest.current;
    void api
      .call("logs.read", { id, offset, query: search, plain: true })
      .then((result) => {
        if (request !== readRequest.current) return;
        setContent(result);
        readerRef.current?.scrollTo(0, 0);
      })
      .catch((error) => {
        if (request === readRequest.current) app.notify(error);
      });
  };
  const current = items.find((x) => x.id === selected);
  return (
    <div className={`log-settings ${tab === "browse" ? "is-browsing" : ""}`}>
      <div className="page-heading">
        <div>
          <h1>세션 로그</h1>
          <p>
            접속한 터미널의 출력을 이 기기에 자동 저장하고 최대 30일 보관합니다.
          </p>
        </div>
        <button onClick={refresh}>새로고침</button>
      </div>
      <SettingsTabs
        label="세션 로그 설정"
        value={tab}
        onChange={setTab}
        items={[
          { id: "browse", label: "로그 조회" },
          { id: "retention", label: "기록·보관 설정" },
        ]}
      >
        {tab === "retention" && (
          <section className="settings-card">
            <label className="check-label">
              <input
                type="checkbox"
                checked={app.document.settings.autoLog}
                onChange={(e) =>
                  void app.update((d) => ({
                    ...d,
                    settings: { ...d.settings, autoLog: e.target.checked },
                  }))
                }
              />
              접속한 터미널 자동 기록
            </label>
            <p className="hint">
              인증에 입력한 비밀번호와 개인 키는 기록하지 않습니다. 터미널에
              출력된 내용은 저장되며 기간 또는 용량을 초과한 오래된 로그부터
              삭제합니다.
            </p>

            <div className="form-row">
              <label>
                보관 일수
                <NumberField
                  min={1}
                  max={30}
                  value={app.document.settings.logRetentionDays}
                  onChange={(value) =>
                    void app.update((d) => ({
                      ...d,
                      settings: {
                        ...d.settings,
                        logRetentionDays: value,
                      },
                    }))
                  }
                />
              </label>
              <label>
                전체 용량 · MiB
                <NumberField
                  min={10}
                  max={1024}
                  value={app.document.settings.logLimitMiB}
                  onChange={(value) =>
                    void app.update((d) => ({
                      ...d,
                      settings: {
                        ...d.settings,
                        logLimitMiB: value,
                      },
                    }))
                  }
                />
              </label>
            </div>
          </section>
        )}
        {tab === "browse" && (
          <div className={`log-layout ${items.length ? "" : "is-empty"}`}>
            <div className="log-list" aria-label="세션 기록 목록" tabIndex={0}>
              {items.map((log) => (
                <button
                  key={log.id}
                  className={log.id === selected ? "active" : ""}
                  aria-pressed={log.id === selected}
                  onClick={() => {
                    setSelected(log.id);
                    setContent({ text: "", offset: 0, next: 0, matches: [] });
                    read(log.id);
                  }}
                >
                  <strong>{log.name}</strong>
                  <small>
                    {new Date(log.started).toLocaleString("ko-KR")} ·{" "}
                    {Math.round(log.bytes / 1024)} KiB{" "}
                    {log.recording ? "· 기록 중" : ""}
                  </small>
                </button>
              ))}
            </div>
            <section className="settings-card log-reader">
              {current ? (
                <>
                  <div className="row">
                    <input
                      aria-label="로그 검색"
                      placeholder="로그에서 찾기"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") read(selected);
                      }}
                    />
                    <button onClick={() => read(selected)}>검색</button>
                    <button onClick={() => read(selected, content.next)}>
                      다음
                    </button>
                  </div>
                  <pre ref={readerRef} tabIndex={0} aria-label="세션 로그 내용">
                    {content.text || "표시할 내용이 없습니다."}
                  </pre>
                  <p className="hint">
                    조회할 때 터미널 제어 코드를 숨깁니다. 화면을 다시 그리는
                    프로그램의 출력은 반복될 수 있으며, 내보내기는 원본 기록을
                    보존합니다.
                  </p>
                  <div className="row">
                    <button
                      onClick={() =>
                        void app
                          .ask("북마크 이름", "현재 로그 위치를 저장합니다.")
                          .then(
                            (label) =>
                              label &&
                              api
                                .call("logs.bookmark", {
                                  id: selected,
                                  offset: content.offset,
                                  label,
                                })
                                .then(refresh),
                          )
                          .catch(app.notify)
                      }
                    >
                      북마크
                    </button>
                    <button
                      onClick={() =>
                        void api
                          .call("logs.export", { id: selected })
                          .catch(app.notify)
                      }
                    >
                      내보내기
                    </button>
                    <button
                      className="danger"
                      onClick={() =>
                        void app
                          .confirm(
                            "로그 삭제",
                            `${current.name} 기록을 삭제할까요?`,
                          )
                          .then((ok) => {
                            if (ok)
                              return api
                                .call("logs.delete", { id: selected })
                                .then(() => {
                                  setSelected("");
                                  refresh();
                                });
                          })
                          .catch(app.notify)
                      }
                    >
                      삭제
                    </button>
                  </div>
                  <div className="log-bookmarks">
                    {current.bookmarks.map((b, i) => (
                      <button
                        key={i}
                        className="text-button"
                        onClick={() => {
                          setQuery("");
                          read(selected, b.offset, "");
                        }}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="hint">
                  {items.length
                    ? "왼쪽에서 기록을 선택하세요."
                    : "아직 기록이 없습니다. 터미널에 접속하면 자동으로 기록을 시작합니다."}
                </p>
              )}
            </section>
          </div>
        )}
      </SettingsTabs>
    </div>
  );
}
export function CustomThemes() {
  const app = useApp(),
    [draft, setDraft] = useState<CustomTheme | null>(null);
  const create = () => {
    const base = getTheme(
      app.document.settings.appearance.theme,
      app.document.settings.customThemes,
    );
    const keys = Object.keys(customThemeSchema.shape.colors.keyType.enum);
    setDraft(
      customThemeSchema.parse({
        id: uuid(),
        name: base.name + " 사용자 테마",
        colors: Object.fromEntries(
          keys.map((k) => [
            k,
            (base.theme as Record<string, string>)[k] || "#ffffff",
          ]),
        ),
      }),
    );
  };
  return (
    <section className="settings-card">
      <h3>사용자 색상 테마</h3>
      <div className="row">
        <button onClick={create}>현재 테마에서 만들기</button>
        <button
          onClick={() =>
            void api
              .call("theme.import", undefined)
              .then((theme) => theme && setDraft({ ...theme, id: uuid() }))
              .catch(app.notify)
          }
        >
          JSON 가져오기
        </button>
      </div>
      <div className="settings-stack custom-theme-list">
        {app.document.settings.customThemes.map((t) => (
          <div className="profile-row" key={t.id}>
            <div>
              <strong>{t.name}</strong>
            </div>
            <button onClick={() => setDraft(t)}>색상 편집</button>
            <button
              onClick={() =>
                void api.call("theme.export", { id: t.id }).catch(app.notify)
              }
            >
              내보내기
            </button>
            <button
              className="danger"
              onClick={() =>
                void app.confirm("테마 삭제", `${t.name}을 삭제할까요?`).then(
                  (ok) =>
                    ok &&
                    app.update((d) => ({
                      ...d,
                      settings: {
                        ...d.settings,
                        customThemes: d.settings.customThemes.filter(
                          (x) => x.id !== t.id,
                        ),
                        appearance:
                          d.settings.appearance.theme === t.id
                            ? { ...d.settings.appearance, theme: "mocha" }
                            : d.settings.appearance,
                      },
                      hosts: d.hosts.map((h) =>
                        h.appearance.theme === t.id
                          ? {
                              ...h,
                              appearance: { ...h.appearance, theme: undefined },
                            }
                          : h,
                      ),
                      groups: d.groups.map((g) =>
                        g.defaults.appearance?.theme === t.id
                          ? {
                              ...g,
                              defaults: {
                                ...g.defaults,
                                appearance: {
                                  ...g.defaults.appearance,
                                  theme: undefined,
                                },
                              },
                            }
                          : g,
                      ),
                    })),
                )
              }
            >
              삭제
            </button>
          </div>
        ))}
      </div>
      {draft && (
        <Modal title="사용자 테마 색상" onClose={() => setDraft(null)}>
          <label>
            테마 이름
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <div className="color-grid">
            {Object.entries(draft.colors).map(([key, color]) => (
              <label key={key}>
                {
                  (
                    {
                      background: "배경",
                      foreground: "글자",
                      cursor: "커서",
                      cursorAccent: "커서 안쪽",
                      selectionBackground: "선택 영역",
                      black: "검정",
                      red: "빨강",
                      green: "초록",
                      yellow: "노랑",
                      blue: "파랑",
                      magenta: "자홍",
                      cyan: "청록",
                      white: "흰색",
                      brightBlack: "밝은 검정",
                      brightRed: "밝은 빨강",
                      brightGreen: "밝은 초록",
                      brightYellow: "밝은 노랑",
                      brightBlue: "밝은 파랑",
                      brightMagenta: "밝은 자홍",
                      brightCyan: "밝은 청록",
                      brightWhite: "밝은 흰색",
                    } as Record<string, string>
                  )[key]
                }
                <input
                  aria-label={`색상 ${key}`}
                  type="color"
                  value={color.slice(0, 7)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      colors: { ...draft.colors, [key]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <button onClick={() => setDraft(null)}>취소</button>
            <button
              className="primary"
              onClick={() =>
                void app
                  .update((d) => ({
                    ...d,
                    settings: {
                      ...d.settings,
                      customThemes: d.settings.customThemes.some(
                        (t) => t.id === draft.id,
                      )
                        ? d.settings.customThemes.map((t) =>
                            t.id === draft.id ? draft : t,
                          )
                        : [...d.settings.customThemes, draft],
                    },
                  }))
                  .then((ok) => ok && setDraft(null))
              }
            >
              테마 저장
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
export function ShortcutSettings() {
  const app = useApp(),
    [draft, setDraft] = useState(app.document.settings.shortcuts),
    [error, setError] = useState("");
  return (
    <section className="settings-card">
      <h3>사용자 단축키</h3>
      <p className="hint">
        Mod는 Mac의 ⌘, Windows의 Ctrl입니다. Platform은 Mac의 ⌘, Windows의
        Ctrl+Shift입니다. 예: Mod+Shift+T
      </p>
      {(!draft.newWindow || draft.newTab === "Mod+Shift+T") && (
        <p className="hint">
          기존 단축키를 보존했습니다. 새 창 단축키가 비어 있거나 기본 키와
          다르면 충돌 여부를 확인해 지정하세요.
        </p>
      )}
      <div className="settings-form-grid">
        {Object.entries({
          copy: "복사",
          paste: "붙여넣기",
          search: "출력 검색",
          nextPane: "다음 패널",
          previousPane: "이전 패널",
          newTab: "새 탭 · 로컬 터미널",
          newWindow: "새 창 · 로컬 터미널 (빈 값으로 끄기)",
          activity: "알림함 (빈 값으로 끄기)",
          recentActivity: "최근 미확인 터미널",
        }).map(([id, label]) => (
          <label key={id}>
            {label}
            <input
              value={draft[id as keyof typeof draft]}
              onChange={(e) => setDraft({ ...draft, [id]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
      <button
        className="primary"
        onClick={() => {
          try {
            validateShortcuts(draft);
            setError("");
            void app.update((d) => ({
              ...d,
              settings: { ...d.settings, shortcuts: draft },
            }));
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        단축키 저장
      </button>
    </section>
  );
}
