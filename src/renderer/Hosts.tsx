import { useState, useEffect, useRef, type FormEvent } from "react";
import {
  Server,
  Plus,
  Search,
  Star,
  Folder,
  ChevronRight,
  Copy,
  Trash2,
  Terminal,
  ArrowLeftRight,
  Settings as SettingsIcon,
  Clock,
  Layers,
  ContactRound,
  KeyRound,
} from "lucide-react";
import { resolveHostSettings, connectionHost } from "../shared/advanced";
import { AuthPicker } from "./AuthPicker";
import { HostExtras, BulkHosts } from "./Advanced";
import { hostSchema, type Host } from "../shared/model";
import { useApp } from "./context";
import { api, uuid } from "./api";
import { Empty, IconButton } from "./components";
import { HostIcon, hostIconNames } from "./HostIcon";
import { hostOS } from "../shared/host-os";
import { themes } from "../shared/themes";
import { panes, removeNode } from "../shared/layout";
import { templatesWithoutHost } from "../shared/workspace-templates";

export function Hosts() {
  const app = useApp(),
    { document: doc, update, ask, confirm, notify } = app;
  const [selected, setSelected] = useState<string | null>(null),
    [draft, setDraft] = useState<Host | null>(null),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [tag, setTag] = useState(""),
    [sort, setSort] = useState("name"),
    [checked, setChecked] = useState<string[]>([]),
    [bulk, setBulk] = useState(false),
    [choosingAuth, setChoosingAuth] = useState(false),
    [password, setPassword] = useState(""),
    [saving, setSaving] = useState(false);
  const savedHost = useRef<Host | null>(null);
  useEffect(() => {
    setPassword("");
  }, [selected]);
  useEffect(() => {
    const next = doc.hosts.find((h) => h.id === selected) ?? null;
    const previous = savedHost.current;
    savedHost.current = next;
    if (!selected) return;
    setDraft((current) => {
      if (!next || current?.id !== next.id || previous?.id !== next.id)
        return next;
      const merged = { ...next };
      for (const field of Object.keys(current) as (keyof Host)[])
        if (JSON.stringify(current[field]) !== JSON.stringify(previous[field]))
          Object.assign(merged, { [field]: current[field] });
      return merged;
    });
  }, [selected, doc.hosts]);
  const groupPath = (id: string | null): string => {
    const g = doc.groups.find((x) => x.id === id);
    return g ? (g.parentId ? groupPath(g.parentId) + " / " : "") + g.name : "";
  };
  const inGroup = (h: Host, id: string): boolean => {
    let current = h.groupId;
    while (current) {
      if (current === id) return true;
      current = doc.groups.find((g) => g.id === current)?.parentId ?? null;
    }
    return false;
  };
  const list = doc.hosts
    .filter(
      (h) =>
        (filter === "all" ||
          (filter === "favorites" && h.favorite) ||
          (filter === "recent" && h.lastConnected > 0) ||
          inGroup(h, filter)) &&
        (!tag || h.tags.includes(tag)) &&
        `${h.name} ${h.address} ${connectionHost(doc, h, app.boot.profiles).username} ${h.tags.join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "recent"
        ? b.lastConnected - a.lastConnected
        : sort === "address"
          ? a.address.localeCompare(b.address)
          : a.name.localeCompare(b.name, "ko"),
    );
  const create = () => {
    setPassword("");
    setSelected(null);
    setDraft({
      ...hostSchema.parse({
        id: uuid(),
        name: "새 호스트",
        address: "localhost",
        username: "root",
        groupId: doc.groups.some((g) => g.id === filter) ? filter : null,
      }),
      name: "",
      address: "",
      username: "",
      port: 0,
    });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const profile = app.boot.profiles.find(
        (p) => p.id === (draft ? resolveHostSettings(doc, draft).authId : null),
      );
      const h = hostSchema.parse({
        ...draft,
        username: profile?.username || draft?.username,
        port:
          draft?.port ||
          (draft?.protocol === "ftp" || draft?.protocol === "ftps" ? 21 : 22),
      });
      if (password && !profile) {
        const id = uuid();
        await api.call("auth.save", {
          id,
          name: `${h.name} 인증`.slice(0, 256),
          username: h.username,
          secret: {
            type: "password",
            password,
            privateKey: "",
            passphrase: "",
          },
        });
        h.authId = id;
        h.inherit = h.inherit.filter((field) => field !== "authId");
        setPassword("");
        setDraft(h);
      }
      const ok = await update((d) => ({
        ...d,
        hosts: d.hosts.some((x) => x.id === h.id)
          ? d.hosts.map((x) => (x.id === h.id ? h : x))
          : [...d.hosts, h],
      }));
      if (ok) {
        setSelected(h.id);
        notify("호스트를 저장했습니다.");
      }
    } catch (e) {
      notify(e);
    } finally {
      setSaving(false);
    }
  };
  const remove = async (h: Host) => {
    const count = doc.workspaces
      .flatMap((w) => panes(w.root))
      .filter((p) => p.hostId === h.id).length;
    if (
      await confirm(
        "호스트 삭제",
        `${h.name}을 삭제할까요?${count ? ` 관련 터미널 ${count}개도 닫습니다.` : ""}`,
      )
    ) {
      await update((d) => ({
        ...d,
        hosts: d.hosts.filter((x) => x.id !== h.id),
        tunnels: d.tunnels.filter((t) => t.hostId !== h.id),
        workspaceTemplates: templatesWithoutHost(d.workspaceTemplates, h.id),
        workspaces: d.workspaces.flatMap((w) => {
          let root: typeof w.root | null = w.root;
          for (const p of panes(w.root))
            if (p.hostId === h.id && root) root = removeNode(root, p.id);
          return root ? [{ ...w, root }] : [];
        }),
      }));
      setSelected(null);
      setDraft(null);
    }
  };
  const renderGroups = (parent: string | null, depth = 0): React.ReactNode =>
    doc.groups
      .filter((g) => g.parentId === parent)
      .map((g) => (
        <div key={g.id}>
          <button
            className={`nav-item ${filter === g.id ? "selected" : ""}`}
            style={{ paddingLeft: 16 + depth * 14 }}
            onClick={() => setFilter(g.id)}
          >
            <Folder size={16} />
            <span>{g.name}</span>
            <small>{doc.hosts.filter((h) => inGroup(h, g.id)).length}</small>
          </button>
          {renderGroups(g.id, depth + 1)}
        </div>
      ));
  const authProfile = app.boot.profiles.find(
    (p) => p.id === (draft ? resolveHostSettings(doc, draft).authId : null),
  );
  return (
    <div className="hosts-view">
      {choosingAuth && draft && (
        <AuthPicker
          selected={authProfile?.id || null}
          onClose={() => setChoosingAuth(false)}
          onSelect={(id) => {
            setDraft({
              ...draft,
              authId: id,
              inherit: draft.inherit.filter((field) => field !== "authId"),
            });
            setPassword("");
            setChoosingAuth(false);
          }}
        />
      )}
      {bulk && (
        <BulkHosts
          ids={checked}
          onClose={() => {
            setBulk(false);
            setChecked([]);
          }}
        />
      )}
      <aside className="host-sidebar">
        <div className="sidebar-label">라이브러리</div>
        <button
          className={`nav-item ${filter === "all" ? "selected" : ""}`}
          onClick={() => setFilter("all")}
        >
          <Layers size={16} />
          모든 호스트<small>{doc.hosts.length}</small>
        </button>
        <button
          className={`nav-item ${filter === "favorites" ? "selected" : ""}`}
          onClick={() => setFilter("favorites")}
        >
          <Star size={16} />
          즐겨찾기
        </button>
        <button
          className={`nav-item ${filter === "recent" ? "selected" : ""}`}
          onClick={() => {
            setFilter("recent");
            setSort("recent");
          }}
        >
          <Clock size={16} />
          최근 접속
        </button>
        <div className="sidebar-label row">
          그룹
          <IconButton
            label="그룹 관리 설정"
            onClick={() => app.openSettings("groups")}
          >
            <SettingsIcon size={16} />
          </IconButton>
        </div>
        {renderGroups(null)}
        <div className="sidebar-foot">
          <span className="dot" />내 기기에 저장됨
        </div>
      </aside>
      <section className="host-main">
        <div className="page-heading">
          <div>
            <div className="eyebrow">나의 연결</div>
            <h1>호스트</h1>
            <p>서버를 한곳에, 작업은 원하는 방식으로.</p>
          </div>
          <button className="primary" onClick={create}>
            <Plus size={16} />새 호스트
          </button>
        </div>
        <div className="host-toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="호스트 검색"
              placeholder="이름, 주소, 계정 또는 태그 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            aria-label="태그 필터"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            <option value="">모든 태그</option>
            {[...new Set(doc.hosts.flatMap((h) => h.tags))].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select
            aria-label="호스트 정렬"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="name">이름순</option>
            <option value="address">주소순</option>
            <option value="recent">최근 접속순</option>
          </select>
        </div>
        <div className="list-label">
          <span>호스트 · {list.length}</span>
          <span>두 번 클릭하여 연결</span>
        </div>
        <div className="bulk-toolbar">
          <label className="check-label">
            <input
              type="checkbox"
              aria-label="현재 목록 전체 선택"
              checked={
                list.length > 0 && list.every((h) => checked.includes(h.id))
              }
              onChange={(e) =>
                setChecked(e.target.checked ? list.map((h) => h.id) : [])
              }
            />
            목록 선택
          </label>
          <button disabled={!checked.length} onClick={() => setBulk(true)}>
            일괄 편집 · {checked.length}
          </button>
        </div>
        <div className="host-list">
          {list.map((h) => (
            <div
              role="button"
              tabIndex={0}
              key={h.id}
              className={`host-row ${selected === h.id ? "selected" : ""}`}
              onClick={() => setSelected(h.id)}
              onDoubleClick={() =>
                h.protocol === "ssh"
                  ? void app.openHost(h)
                  : app.openFiles(h, 1)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setSelected(h.id);
                  if (e.ctrlKey || e.metaKey) void app.openHost(h);
                }
              }}
            >
              <input
                type="checkbox"
                aria-label={`${h.name} 일괄 선택`}
                checked={checked.includes(h.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  setChecked(
                    e.target.checked
                      ? [...checked, h.id]
                      : checked.filter((id) => id !== h.id),
                  )
                }
              />
              <HostIcon host={h} />
              <div className="host-copy">
                <strong>{h.name}</strong>
                <span>
                  {h.protocol.toUpperCase()} ·{" "}
                  {connectionHost(doc, h, app.boot.profiles).username}@
                  {h.address}:{resolveHostSettings(doc, h).port}
                  {h.groupId ? ` · ${groupPath(h.groupId)}` : ""}
                </span>
              </div>
              <div className="tags">
                {h.tags.slice(0, 3).map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <IconButton
                label={h.favorite ? "즐겨찾기 해제" : "즐겨찾기"}
                className={h.favorite ? "favorite" : ""}
                onClick={() =>
                  void update((d) => ({
                    ...d,
                    hosts: d.hosts.map((x) =>
                      x.id === h.id ? { ...x, favorite: !x.favorite } : x,
                    ),
                  }))
                }
              >
                <Star size={16} fill={h.favorite ? "currentColor" : "none"} />
              </IconButton>
              <ChevronRight size={16} className="muted" />
            </div>
          ))}
          {!list.length && (
            <Empty
              icon={<Server size={30} />}
              title={
                doc.hosts.length
                  ? "조건에 맞는 호스트가 없습니다"
                  : "첫 연결을 준비하세요"
              }
              description={
                doc.hosts.length
                  ? "검색어나 그룹 필터를 바꿔 보세요."
                  : "SSH 서버를 등록하면 터미널과 파일 전송을 바로 시작할 수 있습니다."
              }
            >
              <button className="primary" onClick={create}>
                <Plus size={16} />
                호스트 등록
              </button>
            </Empty>
          )}
        </div>
      </section>
      <aside className="host-detail">
        {draft ? (
          <form onSubmit={(e) => void save(e)}>
            <div className="detail-heading">
              <h2>{selected ? "호스트 설정" : "새 호스트"}</h2>
              {selected && (
                <div className="row">
                  <IconButton
                    label="호스트 복제"
                    onClick={() => {
                      setSelected(null);
                      setDraft({
                        ...draft,
                        id: uuid(),
                        name: draft.name + " 복사",
                        lastConnected: 0,
                      });
                    }}
                  >
                    <Copy size={15} />
                  </IconButton>
                  <IconButton
                    label="호스트 삭제"
                    onClick={() => void remove(draft)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              )}
            </div>
            <label>
              이름
              <input
                required
                maxLength={256}
                placeholder="예: 운영 웹 서버"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <div className="form-row">
              <label>
                연결 방식
                <select
                  value={draft.protocol}
                  onChange={(e) => {
                    const protocol = e.target.value as Host["protocol"];
                    setDraft({
                      ...draft,
                      protocol,
                      port: selected
                        ? protocol === "ftp" || protocol === "ftps"
                          ? 21
                          : 22
                        : 0,
                    });
                  }}
                >
                  <option value="ssh">SSH + SFTP</option>
                  <option value="sftp">SFTP</option>
                  <option value="ftp">FTP</option>
                  <option value="ftps">FTPS · 명시적 TLS</option>
                </select>
              </label>
              <label className="small-field">
                포트
                <input
                  type="number"
                  min="1"
                  max="65535"
                  placeholder={
                    draft.protocol === "ftp" || draft.protocol === "ftps"
                      ? "21"
                      : "22"
                  }
                  value={draft.port || ""}
                  onChange={(e) =>
                    setDraft({ ...draft, port: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <label>
              서버 주소
              <input
                required
                placeholder="192.168.0.10"
                value={draft.address}
                onChange={(e) =>
                  setDraft({ ...draft, address: e.target.value })
                }
              />
            </label>
            <div className="credential-section">
              <div className="field-heading">인증</div>
              <button
                type="button"
                className={`credential-card ${authProfile ? "selected" : ""}`}
                aria-label={
                  authProfile ? "저장된 인증 변경" : "저장된 인증 선택"
                }
                onClick={() => setChoosingAuth(true)}
              >
                {authProfile?.type === "key" ? (
                  <KeyRound size={22} />
                ) : (
                  <ContactRound size={22} />
                )}
                <span>
                  <strong>{authProfile?.name || "저장된 인증 선택"}</strong>
                  <small>
                    {authProfile
                      ? `${authProfile.username || "공통 인증"} · ${authProfile.type === "key" ? "SSH 개인 키" : "비밀번호"}`
                      : "등록한 프로필을 선택하거나 아래에 직접 입력"}
                  </small>
                </span>
                <ChevronRight size={17} />
              </button>
              {!authProfile?.username && (
                <label>
                  사용자 이름
                  <input
                    required
                    placeholder="예: root"
                    autoComplete="off"
                    value={draft.username}
                    onChange={(e) =>
                      setDraft({ ...draft, username: e.target.value })
                    }
                  />
                </label>
              )}
              {!authProfile && (
                <>
                  <label>
                    비밀번호
                    <input
                      type="password"
                      autoComplete="new-password"
                      aria-describedby="host-password-help"
                      placeholder="비워 두면 연결할 때 입력"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                  <small className="hint" id="host-password-help">
                    입력한 비밀번호는 호스트 저장 시 암호화된 인증 프로필로
                    보관합니다.
                    {app.boot.platform === "darwin" &&
                      " macOS 키체인 요청에는 Mac의 로그인 키체인 암호를 입력하세요."}
                  </small>
                </>
              )}
              {authProfile && (
                <small className="hint">
                  {authProfile.username
                    ? "이 프로필의 계정으로 연결합니다. 카드를 눌러 인증을 변경할 수 있습니다."
                    : "여러 계정에서 공유하는 인증입니다. 이 호스트의 사용자 이름만 입력하세요."}
                </small>
              )}
            </div>
            <div className="section-line" />
            <label>
              그룹
              <select
                value={draft.groupId ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, groupId: e.target.value || null })
                }
              >
                <option value="">그룹 없음</option>
                {doc.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {groupPath(g.id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              태그
              <input
                placeholder="개발, 빌드, 운영"
                value={draft.tags.join(", ")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    tags: e.target.value.split(",").map((t) => t.trim()),
                  })
                }
                onBlur={() =>
                  setDraft({
                    ...draft,
                    tags: [...new Set(draft.tags.filter(Boolean))],
                  })
                }
              />
            </label>
            <label>
              아이콘
              <select
                aria-label="아이콘"
                value={draft.icon}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    icon: e.target.value as Host["icon"],
                    iconPinned: e.target.value !== "auto",
                  })
                }
              >
                {Object.entries(hostIconNames).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <small className="hint">
              {hostOS(draft).source === "inferred"
                ? hostOS(draft).label
                : draft.detectedOS
                  ? `감지된 운영체제: ${draft.detectedOS}`
                  : "이름에서 OS를 추정하고 SSH 연결 후 실제 운영체제를 확인합니다."}
            </small>
            <HostExtras host={draft} onChange={setDraft} />
            <label>
              파일 시작 경로
              <input
                placeholder="서버 기본 경로"
                value={draft.startPath}
                onChange={(e) =>
                  setDraft({ ...draft, startPath: e.target.value })
                }
              />
            </label>
            {draft.protocol === "ssh" && (
              <>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={draft.autoReconnect}
                    onChange={(e) =>
                      setDraft({ ...draft, autoReconnect: e.target.checked })
                    }
                  />
                  연결 끊김 시 최대 3회 재접속
                </label>
                <details>
                  <summary>SFTP 연결 설정</summary>
                  <label>
                    별도 포트
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      placeholder={String(draft.port)}
                      value={draft.sftpPort ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          sftpPort: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                    />
                  </label>
                  <label>
                    별도 사용자
                    <input
                      placeholder={draft.username}
                      value={draft.sftpUsername ?? ""}
                      onChange={(e) =>
                        setDraft({ ...draft, sftpUsername: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    별도 인증
                    <select
                      value={draft.sftpAuthId ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          sftpAuthId: e.target.value || null,
                        })
                      }
                    >
                      <option value="">SSH와 동일</option>
                      {app.boot.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </details>
              </>
            )}
            <details>
              <summary>터미널 외형</summary>
              <label>
                테마
                <select
                  value={draft.appearance.theme ?? ""}
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
                  <option value="">전체 설정 사용</option>
                  {themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                글꼴
                <input
                  placeholder="전체 설정 사용"
                  value={draft.appearance.font ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      appearance: {
                        ...draft.appearance,
                        font: e.target.value || undefined,
                      },
                    })
                  }
                />
              </label>
              <label>
                글자 크기
                <input
                  type="number"
                  min="8"
                  max="36"
                  placeholder="전체 설정 사용"
                  value={draft.appearance.fontSize ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      appearance: {
                        ...draft.appearance,
                        fontSize: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      },
                    })
                  }
                />
              </label>
            </details>
            <button className="primary full" type="submit" disabled={saving}>
              호스트 저장
            </button>
            {selected && (
              <div className="connect-actions">
                {draft.protocol === "ssh" && (
                  <button
                    type="button"
                    onClick={() =>
                      void app.openHost(
                        doc.hosts.find((h) => h.id === selected)!,
                      )
                    }
                  >
                    <Terminal size={15} />
                    SSH 연결
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    app.openFiles(
                      doc.hosts.find((h) => h.id === selected)!,
                      0,
                    )
                  }
                >
                  <ArrowLeftRight size={15} />
                  파일 왼쪽
                </button>
                <button
                  type="button"
                  onClick={() =>
                    app.openFiles(
                      doc.hosts.find((h) => h.id === selected)!,
                      1,
                    )
                  }
                >
                  파일 오른쪽
                </button>
              </div>
            )}
          </form>
        ) : (
          <div className="detail-placeholder">
            <Server size={28} />
            <h3>연결 정보를 한눈에</h3>
            <p>호스트를 선택해 설정을 확인하거나 새 호스트를 등록하세요.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
