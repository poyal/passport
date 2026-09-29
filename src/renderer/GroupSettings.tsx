import { useState } from "react";
import {
  Folder,
  Plus,
  Pencil,
  SlidersHorizontal,
  Trash2,
  Search,
} from "lucide-react";
import { useApp } from "./context";
import { IconButton, Empty } from "./components";
import { GroupDefaults } from "./Advanced";
import { uuid } from "./api";

export function GroupSettings() {
  const app = useApp();
  const [defaults, setDefaults] = useState<string | null>(null),
    [search, setSearch] = useState("");
  const groupPath = (id: string | null): string => {
    const g = app.document.groups.find((g) => g.id === id);
    return g ? [groupPath(g.parentId), g.name].filter(Boolean).join(" / ") : "";
  };
  const create = async (parentId: string | null = null) => {
    const name = await app.ask(
      "새 그룹",
      parentId
        ? `${groupPath(parentId)} 아래에 만듭니다.`
        : "새 그룹 이름을 입력하세요.",
    );
    if (name?.trim())
      await app.update((d) => ({
        ...d,
        groups: [
          ...d.groups,
          { id: uuid(), name: name.trim(), parentId, defaults: {} },
        ],
      }));
  };
  const group = app.document.groups.find((g) => g.id === defaults);
  const groups = app.document.groups
    .filter((g) => groupPath(g.id).toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => groupPath(a.id).localeCompare(groupPath(b.id), "ko"));
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>그룹 관리</h1>
          <p>그룹을 정리하고 공통 연결 설정을 관리합니다.</p>
        </div>
        <button className="primary" onClick={() => void create()}>
          <Plus size={16} />새 그룹
        </button>
      </div>
      <div className="search-box">
        <Search size={16} />
        <input
          aria-label="그룹 검색"
          placeholder="그룹 이름 또는 경로 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="group-settings-list">
        {groups.map((g) => (
          <div className="profile-row" key={g.id}>
            <Folder size={20} />
            <div>
              <strong>{groupPath(g.id)}</strong>
              <small>
                호스트{" "}
                {app.document.hosts.filter((h) => h.groupId === g.id).length}개
                · 하위 그룹{" "}
                {app.document.groups.filter((x) => x.parentId === g.id).length}
                개
              </small>
            </div>
            <IconButton
              label={`${g.name} 하위 그룹 추가`}
              onClick={() => void create(g.id)}
            >
              <Plus size={16} />
            </IconButton>
            <IconButton
              label={`${g.name} 그룹 기본값`}
              onClick={() => setDefaults(g.id)}
            >
              <SlidersHorizontal size={16} />
            </IconButton>
            <IconButton
              label={`${g.name} 이름 변경`}
              onClick={() =>
                void (async () => {
                  const name = await app.ask(
                    "그룹 이름 변경",
                    "새 이름을 입력하세요.",
                    g.name,
                  );
                  if (name?.trim())
                    await app.update((d) => ({
                      ...d,
                      groups: d.groups.map((x) =>
                        x.id === g.id ? { ...x, name: name.trim() } : x,
                      ),
                    }));
                })()
              }
            >
              <Pencil size={16} />
            </IconButton>
            <IconButton
              label={`${g.name} 그룹 삭제`}
              onClick={() =>
                void (async () => {
                  if (
                    !(await app.confirm(
                      "그룹 삭제",
                      `${groupPath(g.id)}을 삭제할까요? 하위 그룹과 호스트는 상위 그룹으로 이동합니다.`,
                    ))
                  )
                    return;
                  await app.update((d) => ({
                    ...d,
                    groups: d.groups
                      .filter((x) => x.id !== g.id)
                      .map((x) =>
                        x.parentId === g.id
                          ? { ...x, parentId: g.parentId }
                          : x,
                      ),
                    hosts: d.hosts.map((h) =>
                      h.groupId === g.id ? { ...h, groupId: g.parentId } : h,
                    ),
                  }));
                })()
              }
            >
              <Trash2 size={16} />
            </IconButton>
          </div>
        ))}
      </div>
      {!groups.length && (
        <Empty
          icon={<Folder size={28} />}
          title="표시할 그룹이 없습니다"
          description="새 그룹을 만들거나 검색어를 바꿔 보세요."
        />
      )}
      {group && (
        <GroupDefaults group={group} onClose={() => setDefaults(null)} />
      )}
    </>
  );
}
