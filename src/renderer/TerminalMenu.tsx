import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ChevronRight,
  Copy,
  ClipboardPaste,
  Send,
  SquarePen,
} from "lucide-react";
import { api, message } from "./api";
import { useApp } from "./context";
import type { TerminalMenuRequest } from "./terminals";
import { validateMarkdown, type ShareSnapshot } from "../shared/share";

export type ShareComposeRequest = { id: string; text: string };

export function TerminalMenu({
  request,
  onClose,
  onCompose,
  onSend,
  sending,
}: {
  request: TerminalMenuRequest;
  onClose(): void;
  onCompose(text: string): void;
  onSend(to: string, name: string, text: string): void;
  sending: boolean;
}) {
  const app = useApp();
  const layer = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const friends = useRef<HTMLDivElement>(null);
  const send = useRef<HTMLButtonElement>(null);
  const keyboardSubmenu = useRef(false);
  const chosen = useRef(false);
  const [state, setState] = useState<ShareSnapshot>();
  const [error, setError] = useState("");
  const [submenu, setSubmenu] = useState(false);
  const [position, setPosition] = useState({ x: request.x, y: request.y });
  const [subPosition, setSubPosition] = useState({
    x: request.x,
    y: request.y,
  });
  let textError = "";
  try {
    validateMarkdown(request.selection);
  } catch (e) {
    textError = message(e);
  }
  const close = (focus = false) => {
    onClose();
    if (focus && request.valid()) request.focus();
  };
  const openFriendsWithKeyboard = () => {
    if (submenu) {
      (
        friends.current?.querySelector<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? friends.current
      )?.focus();
    } else {
      keyboardSubmenu.current = true;
      setSubmenu(true);
    }
  };
  useLayoutEffect(() => {
    const rect = menu.current!.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(request.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(request.y, window.innerHeight - rect.height - 8)),
    });
    setSubmenu(false);
    chosen.current = false;
    menu.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [request]);
  useLayoutEffect(() => {
    if (!submenu) return;
    const anchor = send.current!.getBoundingClientRect();
    const rect = friends.current!.getBoundingClientRect();
    setSubPosition({
      x: Math.max(
        8,
        anchor.right + rect.width + 8 <= window.innerWidth
          ? anchor.right + 4
          : anchor.left - rect.width - 4,
      ),
      y: Math.max(
        8,
        Math.min(anchor.top, window.innerHeight - rect.height - 8),
      ),
    });
    if (keyboardSubmenu.current) {
      (
        friends.current?.querySelector<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? friends.current
      )?.focus();
      keyboardSubmenu.current = false;
    }
  }, [submenu, state, error, sending]);
  useEffect(() => {
    let alive = true,
      revision = 0;
    setState(undefined);
    setError("");
    const refresh = async () => {
      const current = ++revision;
      try {
        const value = await api.call("share.state", undefined);
        if (alive && current === revision) {
          setState(value);
          setError("");
        }
      } catch (e) {
        if (alive && current === revision) setError(message(e));
      }
    };
    void refresh();
    const off = api.onEvent((event) => {
      if (event.kind === "share-changed") void refresh();
    });
    const dismiss = () => onClose();
    const outside = (event: Event) => {
      if (!layer.current?.contains(event.target as Node)) dismiss();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("passport-terminal-transfer", dismiss);
    window.dispatchEvent(new Event("passport-view-changed"));
    return () => {
      alive = false;
      off();
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("passport-terminal-transfer", dismiss);
      requestAnimationFrame(() =>
        window.dispatchEvent(new Event("passport-view-changed")),
      );
    };
  }, [request]);
  useEffect(() => {
    if (!request.valid()) onClose();
  }, [app.active, app.document, app.sessionStates, request]);
  const key = (event: KeyboardEvent<HTMLDivElement>, child = false) => {
    event.stopPropagation();
    if (event.key === "Escape" || (event.key === "ArrowLeft" && child)) {
      event.preventDefault();
      if (submenu) {
        setSubmenu(false);
        send.current?.focus();
      } else close(true);
    } else if (event.key === "Tab") {
      event.preventDefault();
      close(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const buttons = [
        ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
          ":scope > button:not(:disabled)",
        ),
      ];
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length;
      buttons[next]?.focus();
    } else if (
      event.key === "ArrowRight" &&
      document.activeElement === send.current
    ) {
      event.preventDefault();
      openFriendsWithKeyboard();
    }
  };
  const unavailable =
    (sending ? "쪽지 전송을 준비 중입니다." : "") ||
    error ||
    (!state
      ? "친구 목록을 불러오는 중입니다."
      : !state.settings.enabled
        ? "쪽지를 켜 주세요"
        : state.error
          ? state.error
          : !state.endpoint
            ? "쪽지 연결을 확인해 주세요"
            : !state.peers.length
              ? "등록된 친구가 없습니다"
              : "");
  const choose = (to: string, name: string) => {
    if (chosen.current || sending || unavailable) return;
    if (!request.valid()) return close();
    chosen.current = true;
    close(true);
    onSend(to, name, request.selection);
  };
  return (
    <div ref={layer} className="terminal-menu-layer">
      <div
        ref={menu}
        role="menu"
        aria-label="터미널 메뉴"
        className="context-menu terminal-menu"
        style={{ left: position.x, top: position.y }}
        onKeyDown={(e) => key(e)}
      >
        <button
          role="menuitem"
          disabled={!request.selection}
          onMouseEnter={() => setSubmenu(false)}
          onClick={() => {
            if (request.valid()) request.copy();
            close(true);
          }}
        >
          <Copy size={15} />
          복사
        </button>
        <button
          role="menuitem"
          disabled={!request.canPaste}
          onMouseEnter={() => setSubmenu(false)}
          onClick={() => {
            if (request.valid()) request.paste();
            close(true);
          }}
        >
          <ClipboardPaste size={15} />
          붙여넣기
        </button>
        <div className="menu-divider" role="separator" />
        <button
          ref={send}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenu}
          disabled={!request.selection.trim() || !!textError}
          onMouseEnter={() => {
            if (request.selection.trim() && !textError) setSubmenu(true);
          }}
          onClick={openFriendsWithKeyboard}
        >
          <Send size={15} />
          바로 보내기
          <ChevronRight size={15} className="submenu-arrow" />
        </button>
        <button
          role="menuitem"
          disabled={!request.selection.trim() || !!textError}
          onMouseEnter={() => setSubmenu(false)}
          onClick={() => {
            if (chosen.current) return;
            if (!request.valid()) return close();
            chosen.current = true;
            close();
            onCompose(request.selection);
          }}
        >
          <SquarePen size={15} />
          쪽지로 작성
        </button>
        {textError && <div className="context-caption">{textError}</div>}
      </div>
      {submenu && (
        <div
          ref={friends}
          role="menu"
          aria-label="쪽지 받을 친구"
          tabIndex={-1}
          className="context-menu terminal-friends-menu"
          style={{ left: subPosition.x, top: subPosition.y }}
          onKeyDown={(e) => key(e, true)}
        >
          {unavailable ? (
            <div className="context-caption" role="status">
              {unavailable}
            </div>
          ) : (
            state!.peers.map((peer) => (
              <button
                key={peer.id}
                role="menuitem"
                title={`${peer.name} · ${peer.id}`}
                onClick={() => choose(peer.id, peer.name)}
              >
                <span className="terminal-peer-name">{peer.name}</span>
                {state!.peers.filter((p) => p.name === peer.name).length >
                  1 && <small>{peer.id.slice(0, 8)}</small>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
