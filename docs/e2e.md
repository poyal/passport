# E2E 실행과 앱 재사용

일반 E2E는 창 표시와 네이티브 포커스를 차단한 숨김 모드로 실행한다. UI 사례마다 Electron을 새로 시작하지 않고, 초기화 범위가 명확한 사례는 같은 파일 또는 `describe` 안에서 앱 프로세스와 기본 창을 재사용한다. 실제 종료·재시작·시작 환경 검사는 독립 실행을 유지한다.

## 실행 규칙

Windows 실행 도구와 릴리즈 검증 도구는 GUI 실행 전후에 검사 대상의 node-pty·내장 런타임 경로를 조회한다. 시작 전부터 있던 PID·생성 시각은 제외하고 새로 남은 프로세스가 있으면 실패한다. 결과는 `artifact.json` 또는 `*-native-processes.json`에 기록하며 프로세스를 이름으로 일괄 종료하지 않는다. 조회 자체가 실패해도 통과로 처리하지 않는다.

```sh
# 앱 코드도 변경했다면 먼저 빌드
npm run test:e2e

# 앱 빌드가 최신이고 시험 코드만 바꿨다면 필요한 사례만 실행
node scripts/e2e.mjs tests/e2e/reuse.spec.ts tests/e2e/paste.spec.ts

# 기존 패키지를 검사할 때는 검사 대상 실행 파일을 명시
PASSPORT_E2E_EXECUTABLE="$PWD/release/builds/Passport.app/Contents/MacOS/Passport" node scripts/e2e.mjs
```

`--show`와 `--desktop`은 사용자가 창 표시 또는 실제 데스크톱 검사를 명시적으로 요청한 경우에만 사용한다. 일반적인 수정·검증 요청을 표시 모드의 허용으로 해석하지 않는다. 숨김 모드에서 할 수 없는 OS 포커스 검사는 미검증으로 기록한다. `page.focus()` 같은 DOM 입력 대상 지정과 네이티브 창 포커스는 구분한다.

`playwright.config.ts`는 worker 1개, `fullyParallel: false`로 실행한다. 재시작을 줄이려고 worker를 늘리지 않는다. 앱 빌드가 숨김 실행을 지원하지 않으면 실행 도구가 거부한다. 사용자 앱·데이터·일반 클립보드를 재사용하지 않는다.

긴 파일 목록의 레이아웃 검사는 Enter 뒤 양쪽 패널의 `aria-busy=false`를 최대 30초 기다린 다음 항목 수·메뉴·스크롤을 확인한다. 디스크 조회 중 이전 목록을 판정하지 않으며, 전역 제한 시간·재시도·필수 사례 목록은 바꾸지 않는다. 원격에서 파일 메타데이터를 순차 조회할 때 지연이 누적된 문제는 제품의 제한된 동시 조회로 별도 수정했다.

## 재사용할 수 있는 검사

| 사례                                                           | 실행 방식과 이유                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 레이아웃 드래그, 로컬 색상, 붙여넣기, 터미널 UI·링크, 업데이트 | 파일당 앱 1개. 사례 사이에 문서·세션·창·모의 API를 복구                                    |
| `local-workspace.spec.ts`의 숨김 UI 3개                        | `local workspace UI` describe당 앱 1개. 별도 환경이 필요한 CLI 데스크톱 사례는 바깥에 유지 |
| Windows 셸 4개                                                 | Windows에서 앱 1개. 실제 셸과 PTY는 사례마다 새로 생성. Mac에서는 앱 실행 없이 생략        |
| 앱 종료·재시작 후 복원, 서로 다른 시작 환경, CLI 환경 상속     | 사례의 핵심이 프로세스 수명이므로 독립 앱 유지                                             |
| 전송·가져오기·자격 증명·장시간 비동기 작업                     | 기존 격리 방식 유지. 초기화 계약을 먼저 확장·검증하기 전에는 재사용 대상으로 옮기지 않음   |

여러 파일을 하나의 전역 앱으로 묶지 않는다. 현재 fixture는 전체 DB나 모든 메인 프로세스 singleton을 초기화하는 범용 장치가 아니다. 파일이 달라지면 새 임시 데이터 폴더와 새 앱을 사용한다. 각 파일을 단독 실행하거나 중간 사례만 골라도 그 파일의 `beforeAll`부터 시작한다.

## 재사용 fixture의 계약

구현은 [reusable-app.ts](../tests/fixtures/reusable-app.ts), 초기화 회귀는 [reuse.spec.ts](../tests/e2e/reuse.spec.ts)다.

```ts
import { test, expect } from "@playwright/test";
import { reusableApp } from "../fixtures/reusable-app";

const suite = reusableApp({ name: "example-ui" });

test("opens the host screen", async () => {
  const { page } = suite;
  await page.getByRole("button", { name: "호스트", exact: true }).click();
  await expect(page.locator(".hosts-view")).toBeVisible();
});
```

`shortcuts-settings.spec.ts`는 같은 앱을 재사용하며 단축키 편집·휠 스크롤·파일 조작을 확인한다. Windows 플랫폼을 bootstrap에 주입하는 입력 검사는 Windows 네이티브 검증이 아니다. 사례 소유 IPC 캡처 상태는 afterEach에서 제거하며 기존 passport:call 모의는 fixture가 복구한다. 키보드 문맥은 페이지 탐색 시 제품 코드가 초기화하고 포커스에 따라 다시 설정한다.

`app.spec.ts`의 파일 복사 사례는 목적지의 실제 `files.list` 응답을 명시적 gate로 지연시켜, 조회 중 이전 경로로 복사할 수 없고 완료 후 새 경로로 복사되는지 확인한다. 고정 sleep이나 제한 시간 확대를 사용하지 않는다. 이 파일은 독립 수명을 유지하며 사례의 `finally`에서 gate를 풀고 원래 IPC handler를 복구한 뒤 동일성을 검사한다.

같은 사례에서 실제 로컬 전송의 완료 이벤트도 잠시 보관했다가 경로 입력 후 전달한다. 새 파일이 목록에 나타나는 것으로 자동 새로고침 완료를 확인하고, 입력 경로 보존과 해당 경로 이동을 검사한다. 임시 `webContents.send` 변경은 `finally`에서 원래 메서드로 복구하며 보관한 이벤트도 전달한다. 모의 전송 성공으로 대체하지 않는다.

로컬 터미널의 `1 / 1 연결`은 PTY 연결 상태이며 셸의 입력 준비 완료를 뜻하지 않는다. Windows의 기본 Passport Bash에 명령을 입력하는 GUI는 [terminal-ready.ts](../tests/fixtures/terminal-ready.ts)의 `waitForLocalPrompt()`로 실제 `$` 프롬프트 출력을 먼저 확인한다. 셸 종류를 직접 고르는 시험은 해당 셸의 프롬프트를 기다린다. 시작 도중 입력 자체가 목적이라면 이 대기를 사용하지 않고 별도 시나리오로 검증한다.

Windows 셸 프로필·붙여넣기 검사는 각 명령의 고유 결과와 다음 프롬프트를 모두 확인한 뒤 다음 명령을 입력한다. Bash의 결과 행과 OSC 133;A만으로 readline 준비를 판정하지 않는다. 원격 추적에서는 다음 프롬프트 136ms 전에 입력된 `cat `이 키 이벤트·IPC·PTY 쓰기까지 같은 순서였으나 Bash에서 `t ca`로 재배치됐다. 붙여넣기 접두사의 입력 지연은 0으로 유지하며, 이 준비 조건 변경을 프롬프트 전 입력 결함의 제품 수정으로 표시하지 않는다.

fixture 호출은 테스트 등록 시 한 번만 한다. `suite.application`, `suite.page`, `suite.directory`는 `beforeAll` 완료 후 접근한다. 각 테스트는 자신의 초기 상태를 직접 준비하고 이전 테스트의 결과나 실행 순서에 의존하지 않는다. 테스트 본문에서 공유 앱을 종료하거나 기본 창을 닫지 않는다.

초기화는 다음 순서를 지킨다.

1. Electron PID·생존 상태·기본 창을 확인하고 이전 사례의 네이티브 API 모의를 원래 속성 descriptor로 복구한다. 특히 `net.fetch`는 앱 리소스 제공에도 사용되므로 페이지를 다시 읽기 **전에** 복구한다.
2. 테스트가 붙인 dialog·request·pageerror 리스너를 제거하고 fixture의 renderer 오류 수집기를 다시 연결한다.
3. 기존 `bootstrap`·`save` IPC로 최초 문서를 복원한다. 현재 revision을 사용하고, 문서에서 제거된 터미널·SSH·터널은 앱의 정상 정리 경로를 따른다. 별도 제품용 테스트 IPC는 추가하지 않는다.
4. 활동 기록·세션 로그·인증 프로필을 삭제하고 localStorage·sessionStorage를 비운다. 테스트가 만든 추가 창을 닫고 기본 창 크기를 1440×900으로 되돌린다. 임시 프로필의 `paste-images`만 정리한다.
5. 같은 기본 창의 renderer를 reload한다. window ID·최초 문서·빈 세션/인증/활동 상태를 확인한다. Electron 프로세스와 기본 네이티브 창은 유지한다.
6. 사례마다 renderer 오류 없음과 네이티브 포커스 0회, 숨김 모드의 표시 0회를 확인한다. 파일 종료 때 `closeCleanly()`로 정상 종료 코드 0·시그널 없음을 검사하고 fixture 소유 임시 폴더를 제거한다.

복구 대상은 clipboard의 `read/readText/writeText`, dialog의 메시지/파일 선택 메서드, `shell.openExternal`, `net.fetch`, `child_process.execFile`, 기본 창의 `isFocused/isVisible`, `Date.now`, `passport:call` IPC handler다. Playwright 메인 프로세스 평가에서 보관하며 IPC handler 복구에는 Electron 내부 `_invokeHandlers`를 사용한다. Electron 업그레이드 시 이 부분과 초기화 회귀를 함께 확인한다.

임의의 전역 변수·이벤트 리스너·진행 중인 promise·전송 작업까지 자동 복구하지 않는다. 새 모의를 추가하면 캡처와 복구 계약도 추가하거나 해당 사례를 독립 실행한다. 서버·named pasteboard 등 사례 전용 외부 자원은 사례가 직접 닫는다. 붙여넣기는 매 사례 별도 named pasteboard를 비워 사용하고 사용자 일반 클립보드는 건드리지 않는다.

업데이트 검사는 메인 프로세스의 확인 캐시가 5초간 유지된다. 이 파일에만 `advanceClockMs: 6000`을 지정해 사례마다 메인 `Date.now`를 누적 전진시키고 종료 때 복구한다. 실제 대기나 앱 재시작 없이 새 모의 응답을 확인하며, 제품의 캐시 정책 자체는 변경하지 않는다. 시간·캐시 경계를 검사하는 사례에는 이 옵션을 사용하지 않는다.

## 실행 횟수와 결과 확인

[e2e.mjs](../scripts/e2e.mjs)는 `release/checks/<실행 ID>/`에 다음 자료를 보관한다.

| 파일                  | 확인할 내용                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `artifact.json`       | 출처·커밋·변경 파일·플랫폼·모드·성공 여부·테스트 통계·`lifecycle` 합계                             |
| `lifecycle.jsonl`     | 실제 launch/window/exit/reuse/shutdown-audit 이벤트와 PID. 환경 변수·클립보드 내용은 기록하지 않음 |
| `report.json`         | 개별 테스트 결과, 재사용 사례의 `electron-session` 첨부(PID·window ID·재사용 여부)                 |
| `e2e.log`, `results/` | 실행 로그, 스크린샷, 실패 시 trace                                                                 |

`launches`는 공통 `electron.launch()`로 시작한 GUI 앱 수, `windows`는 기본 창과 테스트가 의도적으로 만든 추가 창의 총수다. renderer reload와 PTY 재생성은 Electron 시작으로 세지 않는다. 단일 인스턴스 전달 검사에서 직접 `spawn()`한 뒤 즉시 종료하는 보조 프로세스 1개는 이 합계에 포함하지 않는다. 이 보조 프로세스도 해당 사례에서 종료 코드 0·시그널 없음을 따로 확인하며 최적화 전후 동일하게 실행한다. `reusedTests`는 fixture의 두 번째 이후 사례 수이며, 기존 `beforeAll` 기반 자체 재사용이나 회귀 본문의 수동 `reset()`은 포함하지 않는다.

성공한 전체 숨김 실행에서는 `launches === exits === auditedShutdowns`와 `shown === focused === 0`을 함께 확인한다. 프로세스가 비정상 종료하여 audit가 빠진 실행을 0회 포커스 성공으로 해석하지 않는다. 검사 개수와 시작 횟수는 서로 다른 지표이며, 시작 횟수를 낮추기 위해 필수 사례를 삭제하거나 생략하지 않는다.

필수 목록은 [release-policy.json](../tests/e2e/release-policy.json)이다. 전체 소스·패키지 보고서를 `validateGuiReport()`로 대조해 파일·제목·플랫폼별 생략·재시도를 확인한다. 부분 실행과 `--grep`은 진단 결과로만 기록한다. 이번 최적화의 실제 전후 측정은 [검증 기록](verification.md)과 [측정 JSON](benchmarks/e2e-reuse-20261006.json)에 남긴다.

## 변경 검증과 유지보수

fixture를 바꾸면 `reuse.spec.ts`로 실제 세션·설정·로그·추가 창·모의 API를 만든 뒤 같은 PID와 기본 창으로 복구되는지 확인한다. 재사용 대상 파일을 모두 검사하고, 파일의 뒤쪽 사례를 단독 선택해서도 이전 사례 없이 실행되는지 확인한다. 타입·배포 정책 검사를 통과한 뒤 공통 fixture 변경은 소스와 해당 OS 패키지 전체 숨김 GUI로 확인한다.

앱 종료·복원 검사는 재사용으로 치환하지 않는다. Windows 셸을 재사용하도록 수정했어도 Mac의 플랫폼 생략 결과를 Windows 실기 통과로 표시하지 않는다. 사용자 요청 없는 표시 모드·Docker·장시간 부하를 자동 추가하지 않는다. 문서만 수정한 뒤에는 링크·내용 확인으로 끝내고 전체 E2E를 다시 돌리지 않는다.

산출물의 보관·정리에는 [배포 안내](distribution.md#산출물-보관-규칙)를 따른다. 성공 자료는 요약 후 7일, 해결된 실패 자료는 문제 해결 후 7일이 지나면 정리 후보로 검토하며 자동 삭제하지 않는다.
