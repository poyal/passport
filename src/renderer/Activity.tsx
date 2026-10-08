import { Bell, CheckCheck, Trash2 } from "lucide-react";
import { useApp } from "./context";
import { api } from "./api";
import { Empty, ToggleField } from "./components";

export function ActivityView() {
  const app = useApp();
  return (
    <div className="activity-view">
      <div className="page-heading">
        <div>
          <h2>알림함</h2>
          <p>AI 응답 완료와 입력이 필요한 터미널을 확인합니다.</p>
        </div>
        <div className="row">
          <button
            onClick={() => void api.call("activity.read", {}).catch(app.notify)}
          >
            <CheckCheck size={16} />
            모두 읽음
          </button>
          <button
            onClick={() =>
              void api.call("activity.clear", undefined).catch(app.notify)
            }
          >
            <Trash2 size={16} />
            기록 지우기
          </button>
        </div>
      </div>
      {!app.activities.length && (
        <Empty
          icon={<Bell size={30} />}
          title="아직 알림이 없습니다."
          description="로컬 터미널의 AI 작업 알림 프로파일과 에이전트 연동을 켜면 여기에 모입니다."
        >
          <button onClick={() => app.openSettings("notifications")}>
            알림 설정
          </button>
        </Empty>
      )}
      {app.activities.map((item) => (
        <article
          className={`activity-row ${item.read ? "" : "unread"}`}
          key={item.id}
        >
          <div>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
            <small>
              {app.document.workspaces.find((w) => w.id === item.workspaceId)
                ?.name || "종료된 작업"}{" "}
              · {new Date(item.created).toLocaleString()} ·{" "}
              {!item.available
                ? "터미널 종료됨"
                : item.kind === "permission"
                  ? item.resolved
                    ? "대기 해제됨"
                    : "입력 대기"
                  : "알림 기록"}
            </small>
          </div>
          <div className="row">
            <button
              disabled={!item.available}
              onClick={() =>
                void api
                  .call("activity.open", { id: item.id })
                  .catch(app.notify)
              }
            >
              터미널 보기
            </button>
            {!item.read && (
              <button
                onClick={() =>
                  void api
                    .call("activity.read", { id: item.id })
                    .catch(app.notify)
                }
              >
                읽음
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
export function NotificationSettings() {
  const app = useApp(),
    settings = app.document.settings.notifications;
  const save = (patch: Partial<typeof settings>) =>
    app.update((d) => ({
      ...d,
      settings: {
        ...d.settings,
        notifications: { ...d.settings.notifications, ...patch },
      },
    }));
  return (
    <div className="settings-stack">
      <div className="page-heading">
        <div>
          <h2>AI 작업 알림</h2>
          <p>새 로컬 터미널에서 시작하는 CLI에 알림을 연결합니다.</p>
        </div>
      </div>
      <section className="settings-card">
        <h3>에이전트 연동</h3>
        <ToggleField
          label="Claude Code 알림"
          checked={settings.claude}
          onChange={(claude) => void save({ claude })}
        />
        <ToggleField
          label="Codex 알림"
          checked={settings.codex}
          onChange={(codex) => void save({ codex })}
        />
        <p className="hint">
          로컬 터미널 설정에서 ‘AI 작업 알림’ 시작 프로파일도 선택하세요. 실행할
          때만 설정을 전달하며 사용자 설정 파일은 수정하지 않습니다. 연동을 끄면
          열린 터미널의 AI 알림 수신도 즉시 중단합니다. 다시 켤 때는 터미널을
          새로 시작하세요.
        </p>
        {!app.document.settings.terminal.profileIds.includes(
          "ai-notifications",
        ) && (
          <p className="info-banner">
            앱 기본 시작 프로파일에 ‘AI 작업 알림’이 없습니다. 아래에서
            추가하거나 터미널을 열 때 직접 선택하세요.
          </p>
        )}
        <button onClick={() => app.openSettings("terminal")}>
          시작 프로파일 설정
        </button>
        <p className="hint">
          Claude Stop 신호는 ‘응답 종료 신호’, 실제 permission_prompt는 ‘승인
          필요’로 구분합니다. 알림은 CLI에서 입력 대기를 확인한 뒤 늦게 도착할
          수 있습니다. Codex의 기존 notify·TUI 설정은 보존하며, 이 경우 일부
          알림은 생략될 수 있습니다.
        </p>
      </section>
      <section className="settings-card">
        <h3>데스크톱 알림</h3>
        <label>
          표시 조건
          <select
            value={settings.desktop}
            onChange={(e) =>
              void save({ desktop: e.target.value as typeof settings.desktop })
            }
          >
            <option value="background">앱이 백그라운드일 때</option>
            <option value="unfocused">해당 터미널을 보고 있지 않을 때</option>
            <option value="off">표시 안 함 (알림함만)</option>
          </select>
        </label>
        {settings.desktop === "background" && (
          <p className="hint">
            Passport를 보고 있을 때는 알림함에만 쌓입니다. 다른 앱으로 전환하면
            데스크톱 배너도 요청합니다.
          </p>
        )}
        <ToggleField
          label="데스크톱 알림 설명 표시"
          checked={settings.preview}
          onChange={(preview) => void save({ preview })}
        />
        <ToggleField
          label="알림 소리"
          checked={settings.sound}
          onChange={(sound) => void save({ sound })}
        />
        <p className="hint">
          {app.boot.platform === "darwin"
            ? "macOS 시스템 설정 → 알림 → Passport에서 ‘알림 허용’과 배너 표시를 켜세요."
            : "Windows 설정 → 시스템 → 알림에서 Passport 알림과 배너 표시를 켜세요."}{" "}
          운영체제 권한이 꺼져 있으면 앱에서 알림을 보내도 배너가 표시되지
          않습니다.
        </p>
        <div className="row">
          <button
            onClick={() =>
              void api
                .call("activity.test", undefined)
                .then((ok) =>
                  app.notify(
                    ok
                      ? "테스트 알림을 요청했습니다. 표시되지 않으면 운영체제 알림 설정에서 Passport의 알림 허용과 배너 표시를 켜세요."
                      : "이 기기에서 데스크톱 알림을 지원하지 않습니다.",
                  ),
                )
                .catch(app.notify)
            }
          >
            테스트 알림 보내기
          </button>
          <button
            onClick={() =>
              void api.call("activity.settings", undefined).catch(app.notify)
            }
          >
            운영체제 알림 설정 열기
          </button>
        </div>
        <p className="hint">
          기록은 이 기기에 최대 500개, 7일간 보관합니다. CLI 대화 원문·도구
          인자·인증 토큰은 알림 기록에 저장하지 않습니다.
        </p>
      </section>
      <section className="settings-card">
        <h3>지원 범위</h3>
        <p>
          Passport 로컬 셸에서 실행한 Claude/Codex에 연결합니다. SSH 터미널과
          일반 OSC 신호는 ‘터미널 · 확인 필요’로 표시합니다. 알림 클릭은 실행
          중인 패널로 이동하며 승인·명령 실행을 대신하지 않습니다.
        </p>
        <p className="hint">
          Codex에 이미 notify나 별도 프로파일이 있거나 CLI 훅이 꺼져 있으면 해당
          사용자 설정을 유지합니다. 절대 경로로 직접 실행한 CLI는 셸 래퍼를
          거치지 않습니다.
        </p>
      </section>
    </div>
  );
}
