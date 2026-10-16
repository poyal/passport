import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  Copy,
  Paperclip,
  Send,
  ShieldCheck,
  Mail,
  Inbox,
  Search,
  Trash2,
  FileText,
  RefreshCw,
  X,
  Info,
  AlertCircle,
  Pencil,
  ExternalLink,
  BookOpen,
  Clock3,
  CheckCheck,
} from "lucide-react";
import { api, message } from "./api";
import { useApp } from "./context";
import { Modal } from "./components";
import { MessageEditor } from "./MessageEditor";
import { ShareRecipient } from "./ShareRecipient";
import { SharingGuide } from "./SharingGuide";
import {
  shareExtensions,
  shareLabel,
  type ShareSettings,
  type ShareSnapshot,
  type ShareMessage,
} from "../shared/share";

function sameSettings(a: ShareSettings, b: ShareSettings) {
  return (Object.keys(a) as (keyof ShareSettings)[]).every(
    (field) => a[field] === b[field],
  );
}

function useShare() {
  const [state, setState] = useState<ShareSnapshot>();
  const [error, setError] = useState("");
  const refresh = useCallback(
    () =>
      api
        .call("share.state", undefined)
        .then(setState)
        .catch((e) => setError(message(e))),
    [],
  );
  useEffect(() => {
    void refresh();
    return api.onEvent((event) => {
      if (event.kind === "share-changed") void refresh();
    });
  }, [refresh]);
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
      await refresh();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    }
  };
  return { state, error, run, refresh, setState };
}

export function SharingSettings() {
  const { state, error, run, setState } = useShare();
  const [draft, setDraft] = useState<ShareSettings>();
  const previousSettings = useRef<ShareSettings>(undefined);
  const [busy, setBusy] = useState(false),
    [key, setKey] = useState(""),
    [alias, setAlias] = useState(""),
    [invitation, setInvitation] = useState<{ key: string; expires: number }>();
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    address: string;
    busy?: boolean;
    error?: string;
  }>();
  const app = useApp();
  useEffect(() => {
    if (!state) return;
    const previous = previousSettings.current;
    previousSettings.current = state.settings;
    setDraft((current) =>
      !current || (previous && sameSettings(current, previous))
        ? state.settings
        : current,
    );
  }, [state]);
  useEffect(() => {
    if (!invitation) return;
    const timer = setTimeout(
      () => setInvitation(undefined),
      Math.max(0, invitation.expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [invitation]);
  if (!state || !draft)
    return <p role="status">쪽지 설정을 불러오는 중입니다.</p>;
  const change = (value: Partial<ShareSettings>) =>
    setDraft({ ...draft, ...value });
  const missingNetwork =
    draft.enabled && !state.interfaces.some((i) => i.address === draft.address);
  const missingDirectory = draft.enabled && !draft.receiveDirectory.trim();
  const dirty = !sameSettings(draft, state.settings);
  const canApply =
    !busy &&
    !missingNetwork &&
    !missingDirectory &&
    (dirty || (draft.enabled && !state.endpoint));
  return (
    <div className="sharing-settings">
      <div className="page-heading">
        <div>
          <h1>쪽지</h1>
          <p>등록한 상대와 쪽지·파일을 암호화해 주고받습니다.</p>
        </div>
      </div>
      {(error || state.error) && (
        <p className="share-error" role="alert">
          {error || state.error}
        </p>
      )}
      <section className="settings-card">
        <h2>연결과 저장</h2>
        <fieldset className="share-settings-fields" disabled={busy}>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => change({ enabled: e.target.checked })}
            />
            쪽지 사용
          </label>
          <label>
            사용할 네트워크
            <select
              value={draft.address}
              onChange={(e) => change({ address: e.target.value })}
            >
              <option value="">네트워크를 선택하세요</option>
              {state.interfaces.map((i) => (
                <option key={i.address} value={i.address}>
                  {i.name} · {i.address}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.discoverable}
              onChange={(e) => change({ discoverable: e.target.checked })}
            />
            주변 사용자 검색 및 내 기기 표시
          </label>
          <p className="hint">
            주변에 표시되어도 등록키와 상대 승인이 있어야 등록됩니다. 쪽지를 켠
            뒤 새 로컬 터미널에서 passport share를 사용할 수 있습니다.
          </p>
          <label>
            기본 다운로드 폴더
            <div className="row">
              <input readOnly value={draft.receiveDirectory} />
              <button
                onClick={() =>
                  void run(async () => {
                    const folder = await api.call("share.folder", undefined);
                    if (folder) change({ receiveDirectory: folder });
                  })
                }
              >
                폴더 선택
              </button>
            </div>
          </label>
          <label>
            쪽지 자동 정리
            <select
              value={draft.retentionDays ?? "never"}
              onChange={(e) =>
                change({
                  retentionDays:
                    e.target.value === "never" ? null : Number(e.target.value),
                })
              }
            >
              <option value="never">자동 정리 안 함</option>
              {Array.from({ length: 30 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}일 후
                </option>
              ))}
            </select>
          </label>
          <p className="hint">
            기존 쪽지에도 적용됩니다. 다운로드한 파일은 삭제하지 않습니다.
          </p>
        </fieldset>
        {(missingNetwork || missingDirectory) && (
          <p className="hint" role="status">
            {missingNetwork
              ? "쪽지를 사용하려면 사용할 네트워크를 선택하세요."
              : "쪽지를 사용하려면 기본 다운로드 폴더를 선택하세요."}
          </p>
        )}
        <button
          className="primary"
          disabled={!canApply}
          onClick={() => {
            setBusy(true);
            void run(async () => {
              const next = await api.call("share.configure", draft);
              setState(next);
              setDraft(next.settings);
              setInvitation(undefined);
            }).finally(() => setBusy(false));
          }}
        >
          {busy ? "적용 중…" : "쪽지 설정 적용"}
        </button>
        {state.endpoint && (
          <p className="hint">
            연결 주소 {state.endpoint.address}:{state.endpoint.port}
          </p>
        )}
      </section>
      <section className="settings-card">
        <h2>사용자 등록</h2>
        <p>
          등록키를 상대에게 직접 전달하거나 기존 메신저로 보내 주세요. 5분 안에
          한 기기에만 사용할 수 있습니다.
        </p>
        <div className="row share-actions">
          <button
            disabled={!state.endpoint}
            onClick={() =>
              void run(async () =>
                setInvitation(await api.call("share.invite", undefined)),
              )
            }
          >
            등록키 만들기
          </button>
        </div>
        {invitation && (
          <div className="share-invitation">
            <label>
              일회용 등록키
              <textarea readOnly value={invitation.key} spellCheck={false} />
            </label>
            <button
              onClick={() =>
                void run(() =>
                  api.call("clipboard.write", { text: invitation.key }),
                )
              }
            >
              <Copy size={15} />
              등록키 복사
            </button>
            <small>
              등록키를 가진 사람이 등록을 요청할 수 있습니다. 상대를 확인한 뒤
              승인하세요.
            </small>
          </div>
        )}
        <div className="share-form">
          <label>
            상대 별칭
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="승민"
              maxLength={100}
            />
          </label>
          <label>
            상대에게 받은 등록키
            <textarea
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            disabled={!state.endpoint || !alias.trim() || !key.trim()}
            onClick={() =>
              void run(async () => {
                await api.call("share.join", {
                  key: key.trim(),
                  alias: alias.trim(),
                });
                setKey("");
                app.notify(
                  "등록 요청을 보냈습니다. 상대의 승인을 기다려 주세요.",
                );
              })
            }
          >
            등록 요청 보내기
          </button>
        </div>
        {state.nearby.length > 0 && (
          <div>
            <h3>주변 사용자</h3>
            {state.nearby.map((p) => (
              <p key={`${p.endpoint.address}:${p.endpoint.port}`}>
                {p.name}{" "}
                <small>
                  {p.endpoint.address}:{p.endpoint.port} · 등록키 필요
                </small>
              </p>
            ))}
          </div>
        )}
      </section>
      <section className="settings-card">
        <h2>등록된 사용자</h2>
        <p className="hint">
          기기 인증서가 만료되었거나 기기키를 교체하려면 초기화 후 서로 다시
          등록하세요.
        </p>
        <div className="row share-actions">
          <button
            onClick={() =>
              void run(async () => {
                if (
                  await app.confirm(
                    "쪽지 기기키 초기화",
                    "쪽지를 끄고 등록된 사용자와 기기키를 삭제합니다. 보관 쪽지와 다운로드 파일은 유지됩니다. 상대도 기존 등록을 해제하고 새 등록키로 다시 등록해야 합니다.",
                  )
                ) {
                  const next = await api.call("share.reset", undefined);
                  setState(next);
                  setDraft(next.settings);
                  setInvitation(undefined);
                }
              })
            }
          >
            쪽지 기기키 초기화
          </button>
          <button
            onClick={() =>
              void run(async () =>
                setState(await api.call("share.unlock", undefined)),
              )
            }
          >
            사용자 목록 불러오기
          </button>
        </div>
        {state.peers.map((peer) => (
          <div className="share-peer" key={peer.id}>
            <div>
              <strong>{peer.name}</strong>
              <small className="share-fingerprint">{peer.id}</small>
              <small>
                {peer.endpoint.address}:{peer.endpoint.port}
              </small>
            </div>
            <div className="row">
              <button
                className="share-icon-button"
                title="친구 수정"
                aria-label={peer.name + " 수정"}
                onClick={() =>
                  setEditing({
                    id: peer.id,
                    name: peer.name,
                    address: peer.endpoint.address + ":" + peer.endpoint.port,
                  })
                }
              >
                <Pencil size={17} />
              </button>
              <button
                className="share-icon-button"
                title="친구 삭제"
                aria-label={peer.name + " 삭제"}
                onClick={() =>
                  void run(async () => {
                    if (
                      await app.confirm(
                        "친구 삭제",
                        `${peer.name}의 등록과 인증 신뢰를 삭제하고 진행 중인 전송·대기 요청을 취소할까요? 다시 연결하려면 서로 등록해야 합니다.`,
                      )
                    )
                      await api.call("share.peer", {
                        id: peer.id,
                        remove: true,
                      });
                  })
                }
              >
                <Trash2 size={17} />
              </button>
            </div>
          </div>
        ))}
        {!state.peers.length && (
          <p className="hint">등록된 사용자가 없습니다.</p>
        )}
      </section>
      {editing && (
        <Modal
          title="친구 수정"
          onClose={() => {
            if (!editing.busy) setEditing(undefined);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setEditing({ ...editing, busy: true, error: undefined });
              try {
                const [address, port, extra] = editing.address
                  .trim()
                  .split(":");
                if (extra !== undefined)
                  throw new Error("IPv4:포트 형식으로 입력하세요.");
                await api.call("share.peer", {
                  id: editing.id,
                  name: shareLabel.parse(editing.name),
                  endpoint: { address, port: Number(port) },
                });
                setState(await api.call("share.state", undefined));
                setEditing(undefined);
                app.notify("친구 정보를 수정했습니다.");
              } catch (error) {
                setEditing({ ...editing, busy: false, error: message(error) });
              }
            }}
          >
            <fieldset disabled={editing.busy} className="share-settings-fields">
              <label>
                이름
                <input
                  value={editing.name}
                  maxLength={100}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                />
              </label>
              <label>
                연결 주소
                <input
                  value={editing.address}
                  placeholder="192.168.0.3:12345"
                  onChange={(e) =>
                    setEditing({ ...editing, address: e.target.value })
                  }
                />
              </label>
              <p className="hint">
                이름은 내 앱에서만 사용합니다. 주소를 바꿔도 등록된 기기
                인증서는 같아야 합니다.
              </p>
              {editing.error && (
                <p className="share-error" role="alert">
                  {editing.error}
                </p>
              )}
              <div className="row">
                <button type="button" onClick={() => setEditing(undefined)}>
                  취소
                </button>
                <button
                  className="primary"
                  disabled={!editing.name.trim() || !editing.address.trim()}
                >
                  저장
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
    </div>
  );
}

class MarkdownBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p>이 쪽지를 표시할 수 없습니다. 원문 복사를 이용해 주세요.</p>
    ) : (
      this.props.children
    );
  }
}
export function SharedMarkdown({
  text,
  copy,
}: {
  text: string;
  copy(text: string): void;
}) {
  // Bound parser and React tree complexity independently of the byte limit.
  // Extremely nested CommonMark blockquotes can otherwise overflow the stack.
  const lines = text.split(/\r?\n/);
  if (
    lines.length > 4096 ||
    lines.some(
      (line) =>
        line.length > 16384 ||
        /^(?: {0,3}>[ \t]*){65}/.test(line) ||
        /^(?: {256}|\t{64})/.test(line),
    )
  ) {
    return (
      <div className="share-markdown">
        <p className="hint">
          복잡한 Markdown 문법으로 원문을 표시합니다. 전체 Markdown 복사를
          사용할 수 있습니다.
        </p>
        <pre>{text}</pre>
      </div>
    );
  }
  return (
    <MarkdownBoundary key={text}>
      <div className="share-markdown">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSanitize]}
          skipHtml
          components={{
            a: ({ children, href }) => (
              <span>
                {children}
                {href ? <span className="share-link"> ({href})</span> : null}
              </span>
            ),
            img: ({ alt }) => (
              <span className="hint">[이미지{alt ? `: ${alt}` : ""}]</span>
            ),
            input: ({ checked }) => (
              <span aria-label={checked ? "완료" : "미완료"}>
                {checked ? "☑" : "☐"}
              </span>
            ),
            pre: ({ children }) => (
              <div className="share-code">
                <button
                  title="코드 복사"
                  onClick={(e) =>
                    copy(
                      e.currentTarget.parentElement?.querySelector("code")
                        ?.textContent ?? "",
                    )
                  }
                >
                  <Copy size={14} />
                  코드 복사
                </button>
                <pre>{children}</pre>
              </div>
            ),
          }}
        >
          {text}
        </Markdown>
      </div>
    </MarkdownBoundary>
  );
}

export function SharingView({
  onPending,
  openInbox = 0,
}: {
  onPending?(count: number): void;
  openInbox?: number;
}) {
  const { state, error, run, refresh } = useShare();
  const [to, setTo] = useState(""),
    [text, setText] = useState(""),
    [file, setFile] = useState(""),
    [selected, setSelected] = useState<ShareMessage>();
  const [sending, setSending] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [inboxFilter, setInboxFilter] = useState<
    "all" | "pending" | "received"
  >("all");
  const selectionId = useRef<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"inbox" | "send" | "friends">("inbox");
  const [copyingInvitation, setCopyingInvitation] = useState(false);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const app = useApp();
  useEffect(() => setTab("inbox"), [openInbox]);
  useEffect(() => {
    if (state)
      onPending?.(
        state.requests.length +
          state.transfers.filter(
            (t) => t.direction === "incoming" && t.state === "pending",
          ).length,
      );
  }, [state, onPending]);
  useEffect(() => {
    if (selected && state && !state.messages.some((m) => m.id === selected.id))
      setSelected(undefined);
  }, [state, selected]);
  useEffect(() => {
    if (!pendingId || !state) return;
    if (state.messages.some((item) => item.id === pendingId)) {
      const id = pendingId;
      void api
        .call("share.message", { id })
        .then((item) => {
          if (selectionId.current !== id) return;
          setSelected(item);
          setPendingId(undefined);
          setInboxFilter("all");
        })
        .catch(() => {});
    } else if (!state.transfers.some((item) => item.id === pendingId)) {
      setPendingId(undefined);
    }
  }, [pendingId, state]);
  if (!state) return <p role="status">쪽지를 불러오는 중입니다.</p>;
  const incoming = state.transfers.filter(
    (item) => item.direction === "incoming",
  );
  const pending = incoming.find((item) => item.id === pendingId);
  const messages = [
    ...state.messages.map((item) => ({ ...item, request: undefined })),
    ...incoming.map((request) => ({
      id: request.id,
      peerName: request.peerName,
      created: request.created,
      title:
        request.kind === "markdown"
          ? "새 쪽지가 도착했습니다"
          : "파일이 첨부된 쪽지",
      attachment:
        request.kind === "markdown" ? undefined : { name: request.name },
      request,
    })),
  ]
    .filter(
      (item) =>
        (inboxFilter === "all" ||
          (inboxFilter === "pending" ? !!item.request : !item.request)) &&
        `${item.peerName} ${item.title} ${item.attachment?.name ?? ""}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => b.created - a.created);
  const copy = (value: string) =>
    void run(async () => {
      await api.call("clipboard.write", { text: value });
      app.notify("클립보드에 복사했습니다.");
    });
  return (
    <div className="sharing-view">
      <div className="page-heading">
        <div>
          <h1>
            <Mail size={24} /> 쪽지
          </h1>
          <p>상대를 확인하고 승인한 쪽지와 파일만 받습니다.</p>
        </div>
        <div className="row share-actions">
          <button onClick={() => setGuideOpen(true)}>
            <BookOpen size={15} />
            사용가이드
          </button>
          <button
            disabled={!state.endpoint || copyingInvitation}
            title="5분 동안 사용할 일회용 등록키를 복사합니다."
            onClick={() => {
              setCopyingInvitation(true);
              void run(async () => {
                const invitation = await api.call("share.invite", undefined);
                await api.call("clipboard.write", { text: invitation.key });
                app.notify(
                  "등록키를 복사했습니다. 생성 후 5분 동안 사용할 수 있습니다.",
                );
              }).finally(() => setCopyingInvitation(false));
            }}
          >
            <Copy size={15} />
            {copyingInvitation ? "복사 중…" : "등록키 복사"}
          </button>
          <button onClick={() => app.openSettings("sharing")}>쪽지 설정</button>
        </div>
      </div>
      {(error || state.error) && (
        <p role="alert" className="share-error">
          {error || state.error}
        </p>
      )}
      {!state.endpoint && (
        <div className="share-disabled" role="status">
          <AlertCircle size={21} />
          <div>
            <strong>쪽지가 꺼져 있습니다</strong>
            <p>네트워크와 저장 폴더를 선택하고 쪽지를 켜 주세요.</p>
          </div>
          <button onClick={() => app.openSettings("sharing")}>
            쪽지 설정 열기
          </button>
        </div>
      )}
      {state.requests.map((request) => (
        <section className="settings-card share-request" key={request.id}>
          <h2>
            <ShieldCheck size={18} /> 사용자 등록 요청
          </h2>
          <p className="share-fingerprint">{request.fingerprint}</p>
          <p>등록키를 전달한 상대인지 확인하세요.</p>
          <label>
            상대 별칭
            <input
              value={aliases[request.id] ?? ""}
              onChange={(e) =>
                setAliases({ ...aliases, [request.id]: e.target.value })
              }
              placeholder="내가 알아볼 수 있는 이름"
              maxLength={100}
            />
          </label>
          <div className="row">
            <button
              onClick={() =>
                void run(() =>
                  api.call("share.pair", { id: request.id, accept: false }),
                )
              }
            >
              등록 거절
            </button>
            <button
              className="primary"
              disabled={!shareLabel.safeParse(aliases[request.id]).success}
              onClick={() =>
                void run(() =>
                  api.call("share.pair", {
                    id: request.id,
                    accept: true,
                    alias: aliases[request.id].trim(),
                  }),
                )
              }
            >
              사용자 등록 승인
            </button>
          </div>
        </section>
      ))}
      {guideOpen && <SharingGuide onClose={() => setGuideOpen(false)} />}
      <div className="share-tabs" role="tablist" aria-label="쪽지 보기">
        {(
          [
            ["inbox", "받은 쪽지"],
            ["send", "보내기"],
            ["friends", "내 친구"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            id={`share-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`share-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const tabs = ["inbox", "send", "friends"] as const;
              const index = tabs.indexOf(tab);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 2
                    : event.key === "ArrowRight"
                      ? (index + 1) % 3
                      : event.key === "ArrowLeft"
                        ? (index + 2) % 3
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              setTab(tabs[next]);
              document.getElementById(`share-tab-${tabs[next]}`)?.focus();
            }}
          >
            {label}
            {id === "friends" && (
              <span className="share-tab-count">{state.peers.length}</span>
            )}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`share-panel-${tab}`}
        aria-labelledby={`share-tab-${tab}`}
      >
        <div className="share-requests">
          {state.transfers
            .filter(
              (transfer) => tab === "send" && transfer.direction === "outgoing",
            )
            .map((transfer) => (
              <section
                className="settings-card share-request"
                key={transfer.id}
              >
                <div className="row">
                  <strong>
                    {transfer.peerName} ·{" "}
                    {transfer.direction === "incoming" ? "받기" : "보내기"}
                  </strong>
                  <span>
                    {transfer.kind === "message-file"
                      ? "쪽지 + 파일"
                      : transfer.kind === "file"
                        ? "파일"
                        : "쪽지"}
                  </span>
                </div>
                <p>
                  {transfer.name} · {(transfer.bytes / 1024).toFixed(1)} KiB
                </p>
                {transfer.direction === "incoming" &&
                  transfer.kind !== "markdown" && (
                    <p className="hint">
                      저장 위치: {state.settings.receiveDirectory}
                    </p>
                  )}
                {transfer.direction === "incoming" &&
                transfer.state === "pending" ? (
                  <div className="row">
                    <button
                      onClick={() =>
                        void run(() =>
                          api.call("share.approve", {
                            id: transfer.id,
                            accept: false,
                          }),
                        )
                      }
                    >
                      거절
                    </button>
                    <button
                      className="primary"
                      onClick={() =>
                        void run(() =>
                          api.call("share.approve", {
                            id: transfer.id,
                            accept: true,
                          }),
                        )
                      }
                    >
                      {transfer.kind !== "markdown"
                        ? "승인하고 저장"
                        : "쪽지 받기"}
                    </button>
                  </div>
                ) : (
                  <div className="row">
                    <span>
                      {
                        {
                          preparing: "준비 중",
                          pending: "상대 승인 대기",
                          accepted: "수신 승인 완료",
                          sending: "전송 중",
                          delivered: "전달 완료",
                          rejected: "거절됨",
                          expired: "만료됨",
                          cancelled: "취소됨",
                          failed: "실패",
                        }[transfer.state]
                      }
                    </span>
                    <button
                      onClick={() =>
                        void run(() =>
                          api.call("share.cancel", { id: transfer.id }),
                        )
                      }
                    >
                      전송 취소
                    </button>
                  </div>
                )}
              </section>
            ))}
        </div>
        {tab === "send" && (
          <section className="settings-card share-compose">
            <h2>보내기</h2>
            <fieldset className="share-compose-fields" disabled={sending}>
              <ShareRecipient peers={state.peers} value={to} onChange={setTo} />
              <MessageEditor
                value={text}
                onChange={setText}
                disabled={sending}
              />
              <div className="share-compose-footer">
                <div className="share-attachment-picker">
                  <button
                    onClick={() =>
                      void run(async () => {
                        const selectedFile = await api.call(
                          "share.file",
                          undefined,
                        );
                        if (selectedFile) setFile(selectedFile);
                      })
                    }
                  >
                    <Paperclip size={15} />
                    파일 선택
                  </button>
                  {file ? (
                    <div className="row share-attachment">
                      <span title={file}>{file.split(/[\\/]/).pop()}</span>
                      <button
                        title="첨부 제거"
                        aria-label="첨부 제거"
                        onClick={() => setFile("")}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ) : (
                    <span className="hint">첨부 파일 없음</span>
                  )}
                </div>
                <button
                  className="primary"
                  disabled={!to || !state.endpoint || !text.trim() || sending}
                  onClick={async () => {
                    setSending(true);
                    try {
                      await run(async () => {
                        await api.call("share.send", {
                          to,
                          text,
                          ...(file ? { file } : {}),
                        });
                        setText("");
                        setFile("");
                      });
                    } finally {
                      setSending(false);
                    }
                  }}
                >
                  <Send size={15} />
                  {sending ? "준비 중…" : "쪽지 보내기"}
                </button>
              </div>
            </fieldset>
            <div className="share-compose-help">
              <span>상대가 승인하면 전달됩니다.</span>
              <details>
                <summary>
                  <Info size={13} />
                  첨부 최대 100 MiB
                </summary>
                <p>
                  쪽지에 파일 하나를 함께 보낼 수 있습니다. 허용 형식:{" "}
                  {shareExtensions.join(", ")}
                </p>
              </details>
            </div>
          </section>
        )}
        {tab === "inbox" && (
          <section className="settings-card share-inbox-card">
            <div className="share-section-heading">
              <h2>
                받은 쪽지{" "}
                <span className="share-message-count">
                  {state.messages.length + incoming.length}
                </span>
              </h2>
              <button
                className="share-icon-button"
                title="보관 쪽지 불러오기"
                aria-label="보관 쪽지 불러오기"
                onClick={() =>
                  void run(async () => {
                    await api.call("share.unlock", undefined);
                    await refresh();
                  })
                }
              >
                <RefreshCw size={17} />
              </button>
            </div>
            <div className="share-inbox">
              <aside className="share-inbox-sidebar">
                <label className="share-message-search">
                  <Search size={16} />
                  <input
                    aria-label="받은 쪽지 검색"
                    placeholder="보낸 사람, 제목, 파일명 검색"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div
                  className="share-inbox-filters"
                  role="group"
                  aria-label="쪽지 처리 상태"
                >
                  {(
                    [
                      ["all", "전체"],
                      ["pending", "승인 대기"],
                      ["received", "받은 쪽지"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      aria-pressed={inboxFilter === value}
                      onClick={() => {
                        setInboxFilter(value);
                        setSelected(undefined);
                        setPendingId(undefined);
                        selectionId.current = undefined;
                      }}
                    >
                      {label}
                      {value === "pending" && incoming.length > 0 && (
                        <span>{incoming.length}</span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="share-message-list">
                  {messages.map((item) => (
                    <button
                      className={
                        (selected?.id === item.id || pendingId === item.id
                          ? "selected "
                          : "") + (item.request ? "pending" : "")
                      }
                      aria-pressed={
                        selected?.id === item.id || pendingId === item.id
                      }
                      key={item.id}
                      onClick={() => {
                        selectionId.current = item.id;
                        setSelected(undefined);
                        setPendingId(item.request ? item.id : undefined);
                        if (!item.request)
                          void run(async () => {
                            const full = await api.call("share.message", {
                              id: item.id,
                            });
                            if (selectionId.current === item.id)
                              setSelected(full);
                          });
                      }}
                    >
                      <span className="share-message-meta">
                        <strong>{item.peerName}</strong>
                        <time
                          dateTime={new Date(item.created).toISOString()}
                          title={new Date(item.created).toLocaleString()}
                        >
                          {new Date(item.created).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" },
                          )}
                        </time>
                      </span>
                      <span className="share-message-title">
                        {item.title.replace(/^#{1,6}\s+/, "")}
                      </span>
                      {item.request && (
                        <span className="share-pending-badge">
                          <Clock3 size={12} />
                          {item.request.state === "pending"
                            ? "승인 대기"
                            : "받는 중"}
                        </span>
                      )}
                      {!item.request && (
                        <span className="share-received-badge">
                          <CheckCheck size={13} />
                          수신 완료
                        </span>
                      )}
                      {item.attachment && (
                        <small className="share-file-chip">
                          <Paperclip size={12} /> {item.attachment.name}
                        </small>
                      )}
                    </button>
                  ))}
                  {!messages.length && (
                    <p className="share-list-empty">
                      {search
                        ? "검색 결과가 없습니다."
                        : inboxFilter === "pending"
                          ? "승인 대기 중인 쪽지가 없습니다."
                          : "받은 쪽지가 없습니다."}
                    </p>
                  )}
                </div>
                <p className="share-retention">
                  최근 100개 ·{" "}
                  {state.settings.retentionDays === null
                    ? "자동 정리 안 함"
                    : `${state.settings.retentionDays}일 보관`}
                </p>
              </aside>
              {pending ? (
                <article className="share-message-reader share-pending-reader">
                  <header className="share-reader-heading">
                    <div className="share-sender">
                      <span className="share-avatar" aria-hidden="true">
                        {Array.from(pending.peerName)[0]}
                      </span>
                      <div>
                        <strong>{pending.peerName}</strong>
                        <time
                          dateTime={new Date(pending.created).toISOString()}
                        >
                          {new Date(pending.created).toLocaleString()}
                        </time>
                      </div>
                    </div>
                    <span className="share-pending-badge">
                      <Clock3 size={13} />
                      {pending.state === "pending" ? "승인 대기" : "받는 중"}
                    </span>
                  </header>
                  <div className="share-reader-body">
                    <div className="share-pending-summary">
                      <Clock3 size={32} strokeWidth={1.5} />
                      <h3>
                        {pending.state === "pending"
                          ? "이 쪽지를 받을까요?"
                          : "쪽지를 받고 있습니다"}
                      </h3>
                      <p>
                        {pending.state === "pending"
                          ? "보낸 친구와 첨부 정보를 확인하세요. 승인하면 본문이 전달됩니다."
                          : "수신이 끝나면 이곳에 본문이 표시됩니다."}
                      </p>
                    </div>
                    <dl className="share-pending-info">
                      <div>
                        <dt>내용</dt>
                        <dd>
                          {pending.kind === "markdown"
                            ? "쪽지"
                            : pending.kind === "file"
                              ? "파일"
                              : "쪽지 + 파일"}
                        </dd>
                      </div>
                      <div>
                        <dt>크기</dt>
                        <dd>{(pending.bytes / 1024).toFixed(1)} KiB</dd>
                      </div>
                      {pending.kind !== "markdown" && (
                        <>
                          <div>
                            <dt>첨부 파일</dt>
                            <dd>{pending.name}</dd>
                          </div>
                          <div>
                            <dt>저장 위치</dt>
                            <dd>{state.settings.receiveDirectory}</dd>
                          </div>
                        </>
                      )}
                    </dl>
                    {pending.state === "pending" && (
                      <div className="share-pending-actions">
                        <button
                          disabled={approvalBusy}
                          onClick={() => {
                            setApprovalBusy(true);
                            void run(() =>
                              api.call("share.approve", {
                                id: pending.id,
                                accept: false,
                              }),
                            ).finally(() => setApprovalBusy(false));
                          }}
                        >
                          거절
                        </button>
                        <button
                          className="primary"
                          disabled={approvalBusy}
                          onClick={() => {
                            setApprovalBusy(true);
                            void run(() =>
                              api.call("share.approve", {
                                id: pending.id,
                                accept: true,
                              }),
                            ).finally(() => setApprovalBusy(false));
                          }}
                        >
                          {pending.kind === "markdown"
                            ? "쪽지 받기"
                            : "승인하고 저장"}
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              ) : selected ? (
                <article className="share-message-reader">
                  <header className="share-reader-heading">
                    <div className="share-sender">
                      <span className="share-avatar" aria-hidden="true">
                        {Array.from(selected.peerName)[0]}
                      </span>
                      <div>
                        <strong>{selected.peerName}</strong>
                        <time
                          dateTime={new Date(selected.created).toISOString()}
                        >
                          {new Date(selected.created).toLocaleString()}
                        </time>
                      </div>
                    </div>
                    <div className="share-reader-actions">
                      <button
                        className="share-icon-button"
                        title="전체 Markdown 복사"
                        aria-label="전체 Markdown 복사"
                        onClick={() => copy(selected.markdown)}
                      >
                        <Copy size={17} />
                      </button>
                      <button
                        className="share-icon-button"
                        title="쪽지 삭제"
                        aria-label="쪽지 삭제"
                        onClick={() =>
                          void run(async () => {
                            await api.call("share.deleteMessage", {
                              id: selected.id,
                            });
                            setSelected(undefined);
                          })
                        }
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </header>
                  <div className="share-reader-body">
                    <SharedMarkdown text={selected.markdown} copy={copy} />
                    {selected.attachment && (
                      <section
                        className="share-attachment-detail"
                        aria-label="첨부 파일"
                      >
                        <span className="share-file-icon">
                          <FileText size={22} />
                        </span>
                        <div>
                          <strong>{selected.attachment.name}</strong>
                          <p>
                            {(selected.attachment.bytes / 1024).toFixed(1)} KiB
                            · 수신 시 저장한 위치
                          </p>
                          <p className="hint">{selected.attachment.path}</p>
                        </div>
                        <div className="share-attachment-actions">
                          <button
                            className="share-icon-button"
                            title="파일 열기"
                            aria-label="첨부 파일 열기"
                            onClick={() =>
                              void run(() =>
                                api.call("share.openAttachment", {
                                  id: selected.id,
                                }),
                              )
                            }
                          >
                            <ExternalLink size={17} />
                          </button>
                          <button
                            className="share-icon-button"
                            title="경로 복사"
                            aria-label="첨부 경로 복사"
                            onClick={() => copy(selected.attachment!.path)}
                          >
                            <Copy size={17} />
                          </button>
                        </div>
                      </section>
                    )}
                  </div>
                </article>
              ) : (
                <div className="share-reader-empty">
                  <span>
                    <Inbox size={30} strokeWidth={1.5} />
                  </span>
                  <h3>
                    {state.messages.length
                      ? "쪽지를 선택하세요"
                      : "받은 쪽지가 여기에 모입니다"}
                  </h3>
                  <p>
                    {state.messages.length
                      ? "본문과 첨부 파일을 한곳에서 확인하세요."
                      : "상대의 요청을 승인하면 쪽지를 읽을 수 있습니다."}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}
        {tab === "friends" && (
          <section className="settings-card share-friends">
            <div className="share-section-heading">
              <h2>내 친구</h2>
              <div className="row share-actions">
                <button
                  onClick={() =>
                    void run(() => api.call("share.unlock", undefined))
                  }
                >
                  친구 목록 불러오기
                </button>
                <button onClick={() => app.openSettings("sharing")}>
                  친구 관리
                </button>
              </div>
            </div>
            <p className="hint">
              별칭은 내 앱에서만 사용합니다. 등록할 때 정한 이름으로 친구를
              선택하세요.
            </p>
            {state.peers.map((peer) => (
              <div className="share-peer" key={peer.id}>
                <div>
                  <strong>{peer.name}</strong>
                  <small>
                    {peer.endpoint.address}:{peer.endpoint.port}
                  </small>
                </div>
                <button
                  disabled={!state.endpoint}
                  aria-label={`${peer.name}에게 보내기`}
                  onClick={() => {
                    setTo(peer.id);
                    setTab("send");
                  }}
                >
                  <Send size={15} />
                  보내기
                </button>
              </div>
            ))}
            {!state.peers.length && (
              <p className="hint">
                아직 등록된 친구가 없습니다. 등록키를 전달하고 서로 승인해
                친구를 추가하세요.
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
