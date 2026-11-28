import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { maxUpdateCheckIntervalHours } from "../shared/updates";
import { api } from "./api";
import { useApp } from "./context";

export function UpdatesPanel() {
  const app = useApp();
  const state = app.boot.updateState;
  const checking = state.status === "checking";
  const installation = state.installation;
  const downloading = installation?.phase === "downloading";
  return (
    <section className="settings-card update-card" aria-busy={checking}>
      <div className="settings-card-header">
        <h3>업데이트</h3>
        <button
          type="button"
          disabled={checking || downloading || installation?.phase === "ready"}
          onClick={() =>
            void api.call("updates.check", undefined).catch(app.notify)
          }
        >
          <RefreshCw size={16} className={checking ? "update-spinning" : ""} />
          {checking ? "확인 중…" : "업데이트 확인"}
        </button>
      </div>
      <label>
        자동 업데이트 확인 간격
        <select
          value={app.document.settings.updateCheckIntervalHours}
          onChange={(event) => {
            const hours = Number(event.currentTarget.value);
            void app.update((doc) => ({
              ...doc,
              settings: { ...doc.settings, updateCheckIntervalHours: hours },
            }));
          }}
        >
          {Array.from({ length: maxUpdateCheckIntervalHours }, (_, index) => {
            const hours = index + 1;
            return (
              <option key={hours} value={hours}>
                {hours === 24 ? "24시간마다 (하루)" : `${hours}시간마다`}
              </option>
            );
          })}
        </select>
      </label>
      <div
        className={`update-result ${state.status}`}
        role="status"
        aria-live="polite"
      >
        <strong>{state.message}</strong>
        <div className="update-versions">
          <span>현재 버전 {state.currentVersion}</span>
          {state.latestVersion && (
            <span>최신 공개 버전 {state.latestVersion}</span>
          )}
        </div>
        {state.checkedAt && (
          <small>
            마지막 확인:{" "}
            {new Date(state.checkedAt).toLocaleString("ko-KR", {
              hour12: false,
            })}
          </small>
        )}
      </div>
      {state.status === "available" && (
        <>
          <div className="row update-actions">
            {state.inAppAvailable && (
              <>
                {installation?.phase === "ready" ? (
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void api
                        .call("updates.install", undefined)
                        .catch(app.notify)
                    }
                  >
                    재시작하여 업데이트
                  </button>
                ) : downloading ? (
                  <button
                    type="button"
                    onClick={() =>
                      void api
                        .call("updates.cancel", undefined)
                        .catch(app.notify)
                    }
                  >
                    다운로드 취소
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void api
                        .call("updates.download", undefined)
                        .catch(app.notify)
                    }
                  >
                    <Download size={16} />
                    {installation?.phase === "error"
                      ? "다시 다운로드"
                      : "업데이트 다운로드"}
                  </button>
                )}
              </>
            )}
            {!state.inAppAvailable && state.installerAvailable && (
              <button
                type="button"
                className="primary"
                onClick={() =>
                  void api
                    .call("updates.open", { target: "download" })
                    .catch(app.notify)
                }
              >
                <Download size={16} />
                설치 파일 다운로드
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                void api
                  .call("updates.open", { target: "release" })
                  .catch(app.notify)
              }
            >
              <ExternalLink size={16} />
              변경 내역 보기
            </button>
          </div>
          {installation && (
            <div role="status" aria-live="polite">
              <p>{installation.message}</p>
              {downloading && (
                <progress
                  aria-label="업데이트 다운로드 진행률"
                  value={installation.total ? installation.received : undefined}
                  max={installation.total || 1}
                />
              )}
            </div>
          )}
          {state.inAppAvailable && (
            <p className="hint">
              작업을 마친 뒤 재시작하면 업데이트가 적용됩니다. 실행 중인 터미널
              작업은 종료되며 호스트·인증·설정과 탭·분할 배치는 유지됩니다.
            </p>
          )}
          {!state.inAppAvailable && state.installerAvailable && (
            <p className="hint">
              {app.boot.platform === "darwin"
                ? "작업을 마친 뒤 Passport를 완전히 종료하고, 받은 DMG에서 앱을 응용 프로그램 폴더에 대치하세요."
                : "작업을 마친 뒤 Passport를 완전히 종료하고, 받은 설치 파일을 실행하세요."}{" "}
              기존 호스트·인증·설정과 탭·분할 배치는 유지됩니다.
            </p>
          )}
        </>
      )}
      <p className="hint">
        앱을 시작할 때와 실행 중에 선택한 간격마다 새 버전을 확인합니다.
        업데이트 파일을 받은 뒤 재시작 시점을 직접 선택할 수 있습니다. 앱 내
        업데이트를 지원하지 않는 배포본은 설치 파일 다운로드로 안내합니다.
      </p>
    </section>
  );
}
