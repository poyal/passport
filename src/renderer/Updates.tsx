import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { api } from "./api";
import { useApp } from "./context";

export function UpdatesPanel() {
  const app = useApp();
  const state = app.boot.updateState;
  const checking = state.status === "checking";
  return (
    <section className="settings-card update-card" aria-busy={checking}>
      <div className="settings-card-header">
        <h3>업데이트</h3>
        <button
          type="button"
          disabled={checking}
          onClick={() =>
            void api.call("updates.check", undefined).catch(app.notify)
          }
        >
          <RefreshCw size={16} className={checking ? "update-spinning" : ""} />
          {checking ? "확인 중…" : "업데이트 확인"}
        </button>
      </div>
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
            {state.installerAvailable && (
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
          {state.installerAvailable && (
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
        앱을 시작할 때 새 버전을 자동으로 확인합니다. 설치 파일은 브라우저에서
        다운로드하며 설치와 앱 재시작은 직접 진행합니다.
      </p>
    </section>
  );
}
