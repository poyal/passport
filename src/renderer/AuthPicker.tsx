import { useState } from "react";
import { Search, ContactRound, KeyRound, Check, Pencil } from "lucide-react";
import { useApp } from "./context";
import { Modal, Empty } from "./components";

export function AuthPicker({
  selected,
  onSelect,
  onClose,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const app = useApp();
  const [query, setQuery] = useState("");
  const profiles = app.boot.profiles.filter((p) =>
    `${p.name} ${p.username || ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Modal title="저장된 인증 선택" onClose={onClose}>
      <div className="search-box">
        <Search size={16} />
        <input
          aria-label="인증 검색"
          placeholder="프로필 이름 또는 사용자 이름 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="auth-picker-list">
        <button
          type="button"
          className={`credential-card ${!selected ? "selected" : ""}`}
          onClick={() => onSelect(null)}
        >
          <Pencil size={22} />
          <span>
            <strong>직접 입력</strong>
            <small>호스트별 ID와 비밀번호 사용</small>
          </span>
          {!selected && <Check size={17} />}
        </button>
        {profiles.map((p) => (
          <button
            type="button"
            className={`credential-card ${selected === p.id ? "selected" : ""}`}
            key={p.id}
            onClick={() => onSelect(p.id)}
          >
            {p.type === "key" ? (
              <KeyRound size={22} />
            ) : (
              <ContactRound size={22} />
            )}
            <span>
              <strong>{p.name}</strong>
              <small>
                {p.username || "호스트별 계정"} ·{" "}
                {p.type === "key" ? "SSH 개인 키" : "비밀번호"}
                {p.hasSecret ? "" : " · 연결할 때 입력"}
              </small>
            </span>
            {selected === p.id && <Check size={17} />}
          </button>
        ))}
      </div>
      {!profiles.length && (
        <Empty
          icon={<ContactRound size={26} />}
          title="저장된 인증이 없습니다"
          description={
            query
              ? "다른 이름이나 계정으로 검색해 보세요."
              : "설정 → 인증 프로필에서 공통 인증을 등록할 수 있습니다."
          }
        />
      )}
    </Modal>
  );
}
