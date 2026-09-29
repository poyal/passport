import { useState, type ReactNode } from "react";
import { Search, HardDrive, ChevronRight } from "lucide-react";
import { useApp } from "./context";
import { Modal, Empty } from "./components";
import { HostIcon } from "./HostIcon";
import { connectionHost } from "../shared/advanced";

export function HostPicker({
  title,
  onClose,
  onSelect,
  sshOnly = false,
  local = false,
  children,
}: {
  title: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  sshOnly?: boolean;
  local?: boolean;
  children?: ReactNode;
}) {
  const app = useApp();
  const [search, setSearch] = useState(""),
    [group, setGroup] = useState("");
  const groupPath = (id: string | null): string => {
    const g = app.document.groups.find((g) => g.id === id);
    return g
      ? [g.parentId ? groupPath(g.parentId) : "", g.name]
          .filter(Boolean)
          .join(" / ")
      : "그룹 없음";
  };
  const belongs = (id: string | null): boolean =>
    !group || (!!id && (id === group || belongsParent(id)));
  const belongsParent = (id: string): boolean => {
    const parent = app.document.groups.find((g) => g.id === id)?.parentId;
    return !!parent && (parent === group || belongsParent(parent));
  };
  const hosts = app.document.hosts
    .map((h) => connectionHost(app.document, h, app.boot.profiles))
    .filter(
      (h) =>
        (!sshOnly || h.protocol === "ssh") &&
        belongs(h.groupId) &&
        `${h.name} ${h.address} ${h.username} ${h.tags.join(" ")} ${groupPath(h.groupId)}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        b.lastConnected - a.lastConnected || a.name.localeCompare(b.name, "ko"),
    );
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="picker-toolbar">
        <div className="search-box">
          <Search size={16} />
          <input
            autoFocus
            aria-label="연결할 호스트 검색"
            placeholder="이름, 주소, 계정 또는 태그 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          aria-label="연결 그룹"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          <option value="">모든 그룹</option>
          {app.document.groups.map((g) => (
            <option value={g.id} key={g.id}>
              {groupPath(g.id)}
            </option>
          ))}
        </select>
      </div>
      {children}
      <p className="hint">{hosts.length}개 호스트 · 선택하면 연결합니다.</p>
      <div className="host-picker-list">
        {local &&
          !group &&
          (!search || "내 컴퓨터 local".includes(search.toLowerCase())) && (
            <button className="host-choice" onClick={() => onSelect("local")}>
              <div className="host-icon">
                <HardDrive size={20} />
              </div>
              <span>
                <strong>내 컴퓨터</strong>
                <small>로컬 파일</small>
              </span>
              <ChevronRight size={16} />
            </button>
          )}
        {hosts.map((h) => (
          <button
            className="host-choice"
            key={h.id}
            onClick={() => onSelect(h.id)}
          >
            <HostIcon host={h} />
            <span>
              <strong>{h.name}</strong>
              <small>
                {h.username}@{h.address}:{h.port} · {groupPath(h.groupId)}
              </small>
            </span>
            <ChevronRight size={16} />
          </button>
        ))}
        {!hosts.length && !local && (
          <Empty
            icon={<Search size={24} />}
            title="검색 결과가 없습니다"
            description="다른 이름, 주소 또는 그룹을 선택해 보세요."
          />
        )}
      </div>
    </Modal>
  );
}
