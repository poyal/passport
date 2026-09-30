import { useState } from "react";
import {
  Palette,
  KeyRound,
  Download,
  Upload,
  FolderOpen,
  Plus,
  Trash2,
  Shield,
  Archive,
  Network,
  FileText,
  Keyboard,
  Check,
  Info,
  GitBranch,
  Mail,
  Bug,
  ExternalLink,
} from "lucide-react";
import { about } from "../shared/about";
import type {
  Secret,
  ImportPreview,
  ImportPasswordRequest,
} from "../shared/model";
import { api, uuid, message } from "./api";
import { useApp } from "./context";
import { Modal, IconButton, SettingsTabs } from "./components";
import {
  TunnelSettings,
  LogSettings,
  CustomThemes,
  ShortcutSettings,
} from "./Advanced";
import { GroupSettings } from "./GroupSettings";
import { AppearancePanel } from "./Workspaces";
import { UpdatesPanel } from "./Updates";
export const blankSecret = (): Secret => ({
  type: "password",
  password: "",
  privateKey: "",
  passphrase: "",
});
export function SecretEditor({
  secret,
  onChange,
}: {
  secret: Secret;
  onChange: (s: Secret) => void;
}) {
  const app = useApp();
  return (
    <>
      <label>
        인증 방식
        <select
          value={secret.type}
          onChange={(e) =>
            onChange({ ...secret, type: e.target.value as Secret["type"] })
          }
        >
          <option value="password">비밀번호</option>
          <option value="key">SSH 개인 키</option>
        </select>
      </label>
      {secret.type === "password" ? (
        <label>
          비밀번호
          <input
            autoComplete="off"
            type="password"
            value={secret.password}
            onChange={(e) => onChange({ ...secret, password: e.target.value })}
          />
        </label>
      ) : (
        <>
          <label>
            개인 키
            <div className="row">
              <button
                type="button"
                onClick={() =>
                  void api
                    .call("key.pick", undefined)
                    .then((key) => {
                      if (key !== null)
                        onChange({ ...secret, privateKey: key });
                    })
                    .catch(app.notify)
                }
              >
                <FolderOpen size={15} />키 파일 선택
              </button>
              <small>
                {secret.privateKey ? "키를 불러왔습니다." : "OpenSSH / PEM"}
              </small>
            </div>
          </label>
          <label>
            키 암호
            <input
              autoComplete="off"
              type="password"
              value={secret.passphrase}
              onChange={(e) =>
                onChange({ ...secret, passphrase: e.target.value })
              }
            />
          </label>
        </>
      )}
    </>
  );
}
export function Settings() {
  const app = useApp(),
    section = app.settingsSection,
    [profile, setProfile] = useState<{
      id: string;
      name: string;
      username: string;
      secret: Secret;
    } | null>(null),
    [includeSecrets, setIncludeSecrets] = useState(false),
    [password, setPassword] = useState(""),
    [importPassword, setImportPassword] = useState(""),
    [encryptedImport, setEncryptedImport] =
      useState<ImportPasswordRequest | null>(null),
    [importError, setImportError] = useState(""),
    [kind, setKind] = useState<"passport" | "ssh" | "snippets">("passport"),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [conflict, setConflict] = useState<"skip" | "overwrite">("skip"),
    [backups, setBackups] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [appearanceTab, setAppearanceTab] = useState<"app" | "terminal" | "themes">(
      "app",
    ),
    [authTab, setAuthTab] = useState<"profiles" | "keys">("profiles"),
    [dataTab, setDataTab] = useState<"export" | "import" | "backup">("export");
  const loadBackups = () =>
    void api.call("backup.list", undefined).then(setBackups).catch(app.notify);
  const chooseSection = (s: string) => {
    app.openSettings(s);
    if (s === "data") loadBackups();
  };
  const cancelEncryptedImport = () => {
    if (busy) return;
    if (encryptedImport)
      void api
        .call("data.cancel", { token: encryptedImport.token })
        .catch(app.notify);
    setEncryptedImport(null);
    setImportPassword("");
    setImportError("");
  };
  return (
    <div className="settings-view">
      <aside className="settings-sidebar">
        <div className="sidebar-label">환경 설정</div>
        {[
          { id: "appearance", label: "외형", icon: <Palette size={16} /> },
          { id: "tunnels", label: "포트 포워딩", icon: <Network size={16} /> },
          { id: "logs", label: "세션 로그", icon: <FileText size={16} /> },
          { id: "groups", label: "그룹 관리", icon: <FolderOpen size={16} /> },
          { id: "auth", label: "인증 프로필", icon: <KeyRound size={16} /> },
          { id: "data", label: "내보내기와 백업", icon: <Archive size={16} /> },
          {
            id: "shortcuts",
            label: "단축키",
            icon: <Keyboard size={16} />,
          },
          { id: "about", label: "About", icon: <Info size={16} /> },
        ].map((s) => (
          <button
            key={s.id}
            className={`nav-item ${section === s.id ? "selected" : ""}`}
            onClick={() => chooseSection(s.id)}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
        <div className="sidebar-foot">Passport {app.boot.appVersion}</div>
      </aside>
      <div
        className={`settings-content ${section === "logs" ? "settings-logs" : ""}`}
      >
        {section === "groups" && <GroupSettings />}
        {section === "tunnels" && <TunnelSettings />}
        {section === "logs" && <LogSettings />}
        {section === "appearance" && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">나만의 작업 공간</div>
                <h1>외형</h1>
                <p>앱의 분위기와 터미널의 색상을 각각 조절하세요.</p>
              </div>
            </div>
            <SettingsTabs
              label="외형 설정"
              value={appearanceTab}
              onChange={setAppearanceTab}
              items={[
                { id: "app", label: "앱 외형" },
                { id: "terminal", label: "터미널 설정" },
                { id: "themes", label: "테마" },
              ]}
            >
              {appearanceTab === "app" && (
                <section className="settings-card app-appearance-card">
                  <h3>앱 외형</h3>
                  <div className="segmented">
                    {(["system", "dark", "light"] as const).map((m) => (
                      <button
                        key={m}
                        className={
                          app.document.settings.colorMode === m
                            ? "selected"
                            : ""
                        }
                        onClick={() =>
                          void app.update((d) => ({
                            ...d,
                            settings: { ...d.settings, colorMode: m },
                          }))
                        }
                      >
                        {{ system: "시스템", dark: "다크", light: "라이트" }[m]}
                      </button>
                    ))}
                  </div>
                  <p className="hint">언어는 한국어로 제공됩니다.</p>
                  <div className="sample-terminal">
                    <span className="mint">passport</span>{" "}
                    <span className="muted">~</span>
                    <br />$ ssh your-server
                    <br />
                    <span className="muted">연결하고, 나누고, 옮기세요.</span>
                    <br />
                    <span className="cursor-block" />
                  </div>
                </section>
              )}
              {appearanceTab === "terminal" && (
                <section className="settings-card">
                  <h3>터미널 기본 설정</h3>
                  <AppearancePanel section="terminal" />
                </section>
              )}
              {appearanceTab === "themes" && (
                <div className="settings-stack">
                  <section className="settings-card">
                    <h3>터미널 테마</h3>
                    <AppearancePanel section="themes" />
                  </section>
                  <CustomThemes />
                </div>
              )}
            </SettingsTabs>
          </>
        )}
        {section === "auth" && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">안전한 인증 관리</div>
                <h1>인증 프로필</h1>
                <p>여러 호스트에서 사용할 인증 정보를 관리하세요.</p>
              </div>
              <button
                className="primary"
                onClick={() =>
                  setProfile({
                    id: uuid(),
                    name: "",
                    username: "",
                    secret: blankSecret(),
                  })
                }
              >
                <Plus size={16} />
                프로필 등록
              </button>
            </div>
            <SettingsTabs
              label="인증 설정"
              value={authTab}
              onChange={setAuthTab}
              items={[
                { id: "profiles", label: "인증 프로필" },
                { id: "keys", label: "SSH 호스트 키" },
              ]}
            >
              {authTab === "profiles" && (
                <div className="settings-stack">
                  <div className="info-banner">
                    <Shield size={18} />
                    <span>
                      비밀번호와 개인 키는 OS 암호화 저장소로 보호합니다.
                      저장하거나 사용할 때 운영체제가 접근 허용을 요청할 수
                      있습니다.
                      {app.boot.platform === "darwin" &&
                        " ‘Passport Safe Storage’ 요청에는 Mac의 로그인 키체인 암호를 입력하세요. 신뢰하는 설치본에 ‘항상 허용’을 선택하면 이후 요청을 줄일 수 있습니다."}
                    </span>
                  </div>
                  {app.boot.profiles.map((p) => (
                    <div className="profile-row" key={p.id}>
                      <KeyRound size={18} />
                      <div>
                        <strong>{p.name}</strong>
                        <small>
                          {p.username ? `${p.username} · ` : "계정 공통 · "}
                          {p.type === "key" ? "SSH 개인 키" : "비밀번호"} ·{" "}
                          {
                            app.document.hosts.filter(
                              (h) => h.authId === p.id || h.sftpAuthId === p.id,
                            ).length
                          }
                          개 호스트
                          {!p.hasSecret
                            ? " · 인증 정보를 다시 입력해야 합니다."
                            : ""}
                        </small>
                      </div>
                      <button
                        onClick={() =>
                          setProfile({
                            id: p.id,
                            name: p.name,
                            username: p.username || "",
                            secret: { ...blankSecret(), type: p.type },
                          })
                        }
                      >
                        정보 교체
                      </button>
                      <IconButton
                        label="인증 프로필 삭제"
                        onClick={() =>
                          void (async () => {
                            if (
                              await app.confirm(
                                "인증 프로필 삭제",
                                `${p.name}을 삭제할까요?`,
                              )
                            ) {
                              await api.call("auth.delete", { id: p.id });
                              await app.refresh();
                            }
                          })().catch(app.notify)
                        }
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  ))}
                  {!app.boot.profiles.length && (
                    <p className="hint">
                      등록된 인증 프로필이 없습니다. 저장 없이 연결할 때마다
                      입력할 수도 있습니다.
                    </p>
                  )}
                </div>
              )}
              {authTab === "keys" && (
                <section className="settings-card">
                  <h3>SSH 호스트 키</h3>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={app.document.settings.confirmNewHostKeys}
                      onChange={(e) => {
                        const confirmNewHostKeys = e.target.checked;
                        void app.update((d) => ({
                          ...d,
                          settings: { ...d.settings, confirmNewHostKeys },
                        }));
                      }}
                    />
                    첫 연결 지문 확인창 표시
                  </label>
                  <p className="hint">
                    끄면 처음 받은 서버 지문을 확인창 없이 자동 등록합니다. 첫
                    연결 대상이 올바른 서버인지 직접 확인하세요. 등록된 지문이
                    바뀌면 설정과 관계없이 연결을 차단합니다.
                  </p>
                </section>
              )}
            </SettingsTabs>
          </>
        )}
        {section === "data" && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">내 데이터는 내 기기에</div>
                <h1>내보내기와 백업</h1>
                <p>
                  파일로 저장하고 다른 Windows 또는 Mac에서 이어서 사용하세요.
                </p>
              </div>
            </div>
            <SettingsTabs
              label="데이터 관리"
              value={dataTab}
              onChange={(tab) => {
                setDataTab(tab);
                if (tab === "backup") loadBackups();
              }}
              items={[
                { id: "export", label: "내보내기" },
                { id: "import", label: "가져오기" },
                { id: "backup", label: "자동 백업" },
              ]}
            >
              {dataTab === "export" && (
                <section className="settings-card">
                  <h3>
                    <Download size={18} />
                    파일 내보내기
                  </h3>
                  <p>
                    호스트, 그룹, 스니펫, 작업 배치, 스페이스와 설정을
                    저장합니다.
                  </p>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={includeSecrets}
                      onChange={(e) => setIncludeSecrets(e.target.checked)}
                    />
                    비밀번호와 개인 키 포함
                  </label>
                  {includeSecrets && (
                    <label>
                      내보내기 암호
                      <input
                        type="password"
                        aria-label="내보내기 암호"
                        minLength={10}
                        maxLength={1024}
                        aria-describedby="export-password-help"
                        aria-invalid={
                          password.length > 0 && password.length < 10
                        }
                        autoComplete="new-password"
                        placeholder="10자 이상"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                      <small
                        id="export-password-help"
                        className={
                          password.length > 0 && password.length < 10
                            ? "hint error-text"
                            : "hint"
                        }
                        aria-live="polite"
                      >
                        {password.length < 10
                          ? `10자 이상 입력해야 내보낼 수 있습니다. 현재 ${password.length}자입니다.`
                          : `현재 ${password.length}자 · 내보내기 가능합니다.`}{" "}
                        파일에는 암호를 저장하지 않습니다.
                      </small>
                    </label>
                  )}
                  <button
                    disabled={busy || (includeSecrets && password.length < 10)}
                    onClick={() =>
                      void (async () => {
                        setBusy(true);
                        try {
                          const saved = await api.call("data.export", {
                            password: includeSecrets ? password : undefined,
                          });
                          if (saved) {
                            setPassword("");
                            app.notify("내보내기를 완료했습니다.");
                          }
                        } catch (e) {
                          app.notify(e);
                        } finally {
                          setBusy(false);
                        }
                      })()
                    }
                  >
                    <Download size={15} />
                    내보내기
                  </button>
                </section>
              )}
              {dataTab === "import" && (
                <section className="settings-card">
                  <h3>
                    <Upload size={18} />
                    파일 가져오기
                  </h3>
                  <label>
                    파일 종류
                    <select
                      aria-label="파일 종류"
                      value={kind}
                      onChange={(e) => setKind(e.target.value as typeof kind)}
                    >
                      <option value="passport">Passport 설정 파일</option>
                      <option value="ssh">SSH config</option>
                      <option value="snippets">Passport 스니펫 파일</option>
                    </select>
                  </label>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        setBusy(true);
                        try {
                          const result = await api.call("data.preview", {
                            kind,
                          });
                          if (result) {
                            setImportPassword("");
                            setImportError("");
                            if ("needsPassword" in result)
                              setEncryptedImport(result);
                            else setPreview(result);
                          }
                        } catch (e) {
                          app.notify(e);
                        } finally {
                          setBusy(false);
                        }
                      })()
                    }
                  >
                    <FolderOpen size={15} />
                    파일 선택 · 미리보기
                  </button>
                  <p className="hint">
                    암호화된 파일은 선택한 뒤 암호를 입력합니다. 가져오기는
                    서버에 연결하거나 명령을 실행하지 않습니다.
                  </p>
                </section>
              )}
              {dataTab === "backup" && (
                <section className="settings-card backups">
                  <h3>
                    <Archive size={18} />
                    자동 로컬 백업
                  </h3>
                  <p>
                    하루 한 번 저장하며 최근 7개를 보관합니다. 인증 정보는 이
                    기기에서만 복원할 수 있습니다.
                  </p>
                  {backups.map((name) => (
                    <div className="row backup-row" key={name}>
                      <span>{name.slice(0, 10)}</span>
                      <button
                        onClick={() =>
                          void api
                            .call("backup.preview", { name })
                            .then(setPreview)
                            .catch(app.notify)
                        }
                      >
                        복원 미리보기
                      </button>
                    </div>
                  ))}
                  {!backups.length && (
                    <p className="hint">저장된 백업이 없습니다.</p>
                  )}
                </section>
              )}
            </SettingsTabs>
          </>
        )}
        {section === "shortcuts" && (
          <>
            <div className="page-heading">
              <div>
                <h1>단축키</h1>
                <p>터미널 조작 단축키를 변경할 수 있습니다.</p>
              </div>
            </div>
            <ShortcutSettings />
            <div className="settings-card shortcut-reference">
              <h3>기본 조작</h3>
              <table className="shortcut-table">
                <tbody>
                  {[
                    ["현재 명령 중단", "Ctrl C"],
                    [
                      "터미널 글자 크기 조절",
                      app.boot.platform === "darwin"
                        ? "⌘ + / − / 0"
                        : "Ctrl + / − / 0",
                    ],
                    [
                      "파일 전체 선택",
                      app.boot.platform === "darwin" ? "⌘ A" : "Ctrl A",
                    ],
                    ["파일 이름 변경", "F2"],
                    ["컨텍스트 메뉴", "Shift F10"],
                    ["분할 크기 조절", "경계선 포커스 후 방향키"],
                    ["메뉴 · 대화상자 닫기", "Esc"],
                  ].map(([label, key]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td>
                        <kbd>{key}</kbd>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {section === "about" && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">연결하고, 나누고, 옮기세요.</div>
                <h1>About Passport</h1>
                <p>한국어 SSH 터미널과 파일 전송을 하나의 데스크톱 앱에서.</p>
              </div>
            </div>
            <div className="settings-stack">
              <section className="settings-card about-card">
                <h3>
                  Passport <span className="pill">{app.boot.appVersion}</span>
                </h3>
                <dl>
                  <div>
                    <dt>제작자</dt>
                    <dd>{about.creator}</dd>
                  </div>
                  <div>
                    <dt>이메일</dt>
                    <dd>
                      <a
                        href={about.links.email}
                        onClick={(event) => {
                          event.preventDefault();
                          void api
                            .call("external.open", { target: "email" })
                            .catch(app.notify);
                        }}
                      >
                        {about.email}
                      </a>
                    </dd>
                  </div>
                </dl>
                <div className="about-links">
                  {(
                    [
                      ["github", "GitHub", GitBranch],
                      ["issues", "버그 신고 · 기능 제안", Bug],
                      ["releases", "새 버전 다운로드", Download],
                      ["email", "이메일 문의", Mail],
                    ] as const
                  ).map(([target, label, Icon]) => (
                    <a
                      key={target}
                      href={about.links[target]}
                      onClick={(event) => {
                        event.preventDefault();
                        void api
                          .call("external.open", { target })
                          .catch(app.notify);
                      }}
                    >
                      <Icon size={18} />
                      <span>{label}</span>
                      <ExternalLink size={14} />
                    </a>
                  ))}
                </div>
              </section>
              <UpdatesPanel />
              <section className="settings-card">
                <h3>업데이트와 데이터</h3>
                <p>
                  새 설치본으로 앱을 교체해도 이 기기의 호스트·인증·설정은
                  유지됩니다. 앱을 종료한 뒤 교체하세요. 백업은 설정의
                  내보내기와 백업에서 만들 수 있습니다.
                </p>
                <p className="hint">
                  탭과 분할 배치는 복원하며 서버 연결은 직접 다시 시작합니다.
                </p>
              </section>
            </div>
          </>
        )}
      </div>
      {encryptedImport && (
        <Modal title="파일 암호 입력" onClose={cancelEncryptedImport}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !importPassword) return;
              void (async () => {
                setBusy(true);
                setImportError("");
                try {
                  const result = await api.call("data.unlock", {
                    token: encryptedImport.token,
                    password: importPassword,
                  });
                  setEncryptedImport(null);
                  setImportPassword("");
                  setPreview(result);
                } catch (error) {
                  setImportError(message(error));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            <p className="import-file-name">{encryptedImport.name}</p>
            <p className="hint">
              이 파일을 내보낼 때 지정한 암호를 입력하세요.
            </p>
            <label>
              파일 암호
              <input
                type="password"
                autoFocus
                required
                maxLength={1024}
                autoComplete="off"
                aria-invalid={!!importError}
                aria-describedby={
                  importError ? "import-password-error" : undefined
                }
                value={importPassword}
                onChange={(event) => {
                  setImportPassword(event.target.value);
                  setImportError("");
                }}
              />
            </label>
            {importError && (
              <p id="import-password-error" className="error-text" role="alert">
                {importError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                disabled={busy}
                onClick={cancelEncryptedImport}
              >
                취소
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busy || !importPassword}
              >
                {busy ? "확인 중…" : "암호 확인 · 미리보기"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {profile && (
        <Modal title="인증 프로필" onClose={() => setProfile(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                if (profile.secret.type === "key" && !profile.secret.privateKey)
                  throw new Error("키 파일을 선택해 주세요.");
                await api.call("auth.save", profile);
                await app.refresh();
                setProfile(null);
              })().catch(app.notify);
            }}
          >
            <label>
              프로필 이름
              <input
                autoFocus
                required
                maxLength={256}
                value={profile.name}
                onChange={(e) =>
                  setProfile({ ...profile, name: e.target.value })
                }
              />
            </label>
            <label>
              사용자 이름
              <input
                placeholder="비워 두면 호스트별 계정 사용"
                value={profile.username}
                maxLength={256}
                onChange={(e) =>
                  setProfile({ ...profile, username: e.target.value })
                }
              />
              <small className="hint">
                지정하면 연결할 때 이 계정을 사용하며 호스트에서 변경할 수
                없습니다.
              </small>
            </label>
            <SecretEditor
              secret={profile.secret}
              onChange={(secret) => setProfile({ ...profile, secret })}
            />
            <div className="modal-actions">
              <button type="submit" className="primary">
                암호화하여 저장
              </button>
            </div>
          </form>
        </Modal>
      )}
      {preview && (
        <Modal title="가져오기 미리보기" onClose={() => setPreview(null)} wide>
          <div className="import-summary">
            <span>
              호스트 <b>{preview.document.hosts.length}</b>
            </span>
            <span>
              그룹 <b>{preview.document.groups.length}</b>
            </span>
            <span>
              스니펫 <b>{preview.document.snippets.length}</b>
            </span>
            <span>
              작업 배치 <b>{preview.document.workspaces.length}</b>
              스페이스 <b>{preview.document.workspaceTemplates.length}</b>
            </span>
          </div>
          <div className="preview-list">
            {preview.document.hosts.map((h) => (
              <div key={h.id}>
                <strong>{h.name}</strong>
                <span>
                  {h.username}@{h.address}:{h.port}
                </span>
              </div>
            ))}
            {preview.warnings.map((w, i) => (
              <p className="hint" key={i}>
                {w}
              </p>
            ))}
          </div>
          <label>
            중복 항목 처리 · 호스트 {preview.duplicates}개
            <select
              value={conflict}
              onChange={(e) => setConflict(e.target.value as typeof conflict)}
            >
              <option value="skip">기존 항목 유지</option>
              <option value="overwrite">
                가져온 항목으로 덮어쓰기 · 전체 설정도 적용
              </option>
            </select>
          </label>
          <p className="hint">
            동일 ID와 주소·포트·계정을 기준으로 중복을 확인합니다. 저장된 작업
            배치는 연결 전 상태로 복원됩니다.
          </p>
          <div className="modal-actions">
            <button onClick={() => setPreview(null)}>취소</button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    await api.call("data.apply", {
                      token: preview.token,
                      conflict,
                    });
                    await app.refresh();
                    setPreview(null);
                    app.notify("가져오기를 완료했습니다.");
                  } catch (e) {
                    app.notify(e);
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              <Check size={15} />
              가져오기 적용
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
