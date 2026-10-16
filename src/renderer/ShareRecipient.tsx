import { useEffect, useId, useRef, useState } from "react";
import { Search, Check, X, Users } from "lucide-react";
import type { SharePeer } from "../shared/share";

export function ShareRecipient({
  peers,
  value,
  onChange,
}: {
  peers: SharePeer[];
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-option-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);
  const selected = peers.find((peer) => peer.id === value);
  const matches = peers.filter((peer) =>
    `${peer.name} ${peer.id}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const pick = (peer: SharePeer) => {
    onChange(peer.id);
    setQuery("");
    setOpen(false);
  };
  return (
    <div className="share-recipient">
      <label htmlFor={id}>받는 사람</label>
      <div className="share-recipient-input">
        {selected && !open ? <Users size={16} /> : <Search size={16} />}
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-options`}
          aria-activedescendant={
            open && matches[active] ? `${id}-option-${active}` : undefined
          }
          value={open ? query : (selected?.name ?? query)}
          placeholder="친구 이름 또는 기기 ID 검색"
          onFocus={() => {
            setQuery("");
            setActive(0);
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange("");
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setActive((n) =>
                Math.max(
                  0,
                  Math.min(
                    matches.length - 1,
                    n + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            } else if (e.key === "Enter" && open) {
              e.preventDefault();
              if (matches[active]) pick(matches[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              setQuery("");
            }
          }}
        />
        {(value || query) && (
          <button
            type="button"
            aria-label="받는 사람 지우기"
            title="받는 사람 지우기"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange("");
              setQuery("");
              setActive(0);
              setOpen(true);
              input.current?.focus();
            }}
          >
            <X size={15} />
          </button>
        )}
      </div>
      {open && (
        <div
          id={`${id}-options`}
          className="share-recipient-options"
          role="listbox"
          aria-label="등록된 친구"
        >
          {matches.map((peer, i) => (
            <div
              key={peer.id}
              id={`${id}-option-${i}`}
              role="option"
              aria-selected={peer.id === value}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(peer)}
            >
              <span className="share-avatar" aria-hidden="true">
                {Array.from(peer.name)[0]}
              </span>
              <span>
                <strong>{peer.name}</strong>
                <small>
                  {peer.id.slice(0, 12)} · {peer.endpoint.address}
                </small>
              </span>
              {peer.id === value && <Check size={16} />}
            </div>
          ))}
          {!matches.length && (
            <p>
              {peers.length > 0
                ? "일치하는 친구가 없습니다."
                : "등록된 친구가 없습니다. 내 친구에서 친구를 추가하세요."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
