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
import { Copy, Download, Send, ShieldCheck, Users } from "lucide-react";
import { api, message } from "./api";
import { useApp } from "./context";
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
    return <p role="status">공유 설정을 불러오는 중입니다.</p>;
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
          <h1>공유</h1>
          <p>등록한 상대와 메시지·파일을 암호화해 주고받습니다.</p>
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
            공유 사용
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
            주변에 표시되어도 등록키와 상대 승인이 있어야 등록됩니다. 공유를 켠
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
            메시지 자동 정리
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
            기존 메시지에도 적용됩니다. 다운로드한 파일은 삭제하지 않습니다.
          </p>
        </fieldset>
        {(missingNetwork || missingDirectory) && (
          <p className="hint" role="status">
            {missingNetwork
              ? "공유를 사용하려면 사용할 네트워크를 선택하세요."
              : "공유를 사용하려면 기본 다운로드 폴더를 선택하세요."}
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
          {busy ? "적용 중…" : "공유 설정 적용"}
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
                    "공유 기기키 초기화",
                    "공유를 끄고 등록된 사용자와 기기키를 삭제합니다. 보관 메시지와 다운로드 파일은 유지됩니다. 상대도 기존 등록을 해제하고 새 등록키로 다시 등록해야 합니다.",
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
            공유 기기키 초기화
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
                {peer.blocked ? " · 차단됨" : ""}
              </small>
            </div>
            <div className="row">
              <button
                onClick={() =>
                  void run(async () => {
                    const name = await app.ask(
                      "상대 별칭",
                      "CLI에서 사용할 이름입니다.",
                      peer.name,
                    );
                    if (name)
                      await api.call("share.peer", { id: peer.id, name });
                  })
                }
              >
                이름 수정
              </button>
              <button
                onClick={() =>
                  void run(async () => {
                    const address = await app.ask(
                      "상대 연결 주소",
                      "IP가 바뀌어도 등록된 기기 인증서는 같아야 합니다. IPv4:포트 형식으로 입력하세요.",
                      `${peer.endpoint.address}:${peer.endpoint.port}`,
                    );
                    if (address) {
                      const [host, port] = address.split(":");
                      await api.call("share.peer", {
                        id: peer.id,
                        endpoint: { address: host, port: Number(port) },
                      });
                    }
                  })
                }
              >
                주소 수정
              </button>
              <button
                onClick={() =>
                  void run(() =>
                    api.call("share.peer", {
                      id: peer.id,
                      blocked: !peer.blocked,
                    }),
                  )
                }
              >
                {peer.blocked ? "차단 해제" : "차단"}
              </button>
              <button
                onClick={() =>
                  void run(async () => {
                    if (
                      await app.confirm(
                        "사용자 등록 해제",
                        `${peer.name}의 연결과 대기 요청을 취소하고 등록을 해제할까요?`,
                      )
                    )
                      await api.call("share.peer", {
                        id: peer.id,
                        remove: true,
                      });
                  })
                }
              >
                등록 해제
              </button>
            </div>
          </div>
        ))}
        {!state.peers.length && (
          <p className="hint">등록된 사용자가 없습니다.</p>
        )}
      </section>
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
      <p>이 메시지를 표시할 수 없습니다. 원문 복사를 이용해 주세요.</p>
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
    [selected, setSelected] = useState<ShareMessage>();
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
  if (!state) return <p role="status">공유함을 불러오는 중입니다.</p>;
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
            <Users size={24} /> 공유함
          </h1>
          <p>상대를 확인하고 승인한 메시지와 파일만 받습니다.</p>
        </div>
        <div className="row share-actions">
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
          <button onClick={() => app.openSettings("sharing")}>공유 설정</button>
        </div>
      </div>
      {(error || state.error) && (
        <p role="alert" className="share-error">
          {error || state.error}
        </p>
      )}
      {!state.endpoint && (
        <p className="share-empty">
          공유가 꺼져 있습니다. 공유 설정에서 네트워크와 저장 폴더를 선택하세요.
        </p>
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
      <div className="share-tabs" role="tablist" aria-label="공유함 보기">
        {(
          [
            ["inbox", "받은 메시지"],
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
        {state.transfers
          .filter(
            (transfer) =>
              (tab === "inbox" && transfer.direction === "incoming") ||
              (tab === "send" && transfer.direction === "outgoing"),
          )
          .map((transfer) => (
            <section className="settings-card share-request" key={transfer.id}>
              <div className="row">
                <strong>
                  {transfer.peerName} ·{" "}
                  {transfer.direction === "incoming" ? "받기" : "보내기"}
                </strong>
                <span>{transfer.kind === "file" ? "파일" : "Markdown"}</span>
              </div>
              <p>
                {transfer.name} · {(transfer.bytes / 1024).toFixed(1)} KiB
              </p>
              {transfer.direction === "incoming" &&
                transfer.kind === "file" && (
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
                    {transfer.kind === "file" ? "승인하고 저장" : "메시지 받기"}
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
        {tab === "send" && (
          <section className="settings-card share-compose">
            <h2>보내기</h2>
            <label>
              받는 사람
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">등록된 상대 선택</option>
                {state.peers
                  .filter((p) => !p.blocked)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.id.slice(0, 8)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Markdown 메시지
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="# 작업 결과"
              />
            </label>
            <div className="row">
              <button
                className="primary"
                disabled={!to || !state.endpoint || !text}
                onClick={() =>
                  void run(async () => {
                    await api.call("share.send", { to, text });
                    setText("");
                  })
                }
              >
                <Send size={15} />
                메시지 보내기
              </button>
              <button
                disabled={!to || !state.endpoint}
                onClick={() =>
                  void run(async () => {
                    const file = await api.call("share.file", undefined);
                    if (file) await api.call("share.send", { to, file });
                  })
                }
              >
                <Download size={15} />
                파일 보내기
              </button>
            </div>
            <p className="hint">
              파일은 최대 100 MiB이며 상대의 승인 후 저장됩니다. 허용 형식:{" "}
              {shareExtensions.join(", ")}
            </p>
          </section>
        )}
        {tab === "inbox" && (
          <section className="settings-card">
            <div className="share-section-heading">
              <h2>받은 메시지</h2>
              <button
                onClick={() =>
                  void run(async () => {
                    await api.call("share.unlock", undefined);
                    await refresh();
                  })
                }
              >
                보관 메시지 불러오기
              </button>
            </div>
            <p className="hint">
              최근 100개를 표시합니다.{" "}
              {state.settings.retentionDays === null
                ? "자동 정리를 하지 않습니다."
                : `${state.settings.retentionDays}일 후 자동 정리합니다.`}
            </p>
            <div className="share-inbox">
              <div className="share-message-list">
                {state.messages.map((item) => (
                  <button
                    className={selected?.id === item.id ? "selected" : ""}
                    key={item.id}
                    onClick={() =>
                      void run(async () =>
                        setSelected(
                          await api.call("share.message", { id: item.id }),
                        ),
                      )
                    }
                  >
                    <strong>{item.peerName}</strong>
                    <span>{item.title}</span>
                    <small>{new Date(item.created).toLocaleString()}</small>
                  </button>
                ))}
                {!state.messages.length && (
                  <p className="hint">받은 메시지가 없습니다.</p>
                )}
              </div>
              {selected && (
                <article>
                  <div className="row">
                    <strong>{selected.peerName}</strong>
                    <button onClick={() => copy(selected.markdown)}>
                      <Copy size={15} />
                      전체 Markdown 복사
                    </button>
                    <button
                      onClick={() =>
                        void run(async () => {
                          await api.call("share.deleteMessage", {
                            id: selected.id,
                          });
                          setSelected(undefined);
                        })
                      }
                    >
                      메시지 삭제
                    </button>
                  </div>
                  <SharedMarkdown text={selected.markdown} copy={copy} />
                </article>
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
                    {peer.blocked ? " · 차단됨" : ""}
                  </small>
                </div>
                <button
                  disabled={peer.blocked || !state.endpoint}
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
