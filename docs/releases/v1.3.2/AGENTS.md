# Passport AI 작업 규칙

이 문서는 1.3.2 기준의 개발·검증·배포 규칙과 최종 상태입니다. 사용자 조작은 [사용자 매뉴얼](README.md), 버전별 변경 사항은 [GitHub Releases](https://github.com/poyal/passport/releases)를 확인합니다. 사용자에게 항상 한국어 존댓말로 응답합니다.

## 문서와 작업 종료 규칙

- 버전마다 `docs/releases/v<버전>/README.md`와 `AGENTS.md` **두 문서만** 보관합니다. README는 사람이 읽는 사용자 매뉴얼, AGENTS는 AI가 읽는 작업 규칙·구현 계약·최종 검증 결과입니다. 새 릴리즈에서는 두 문서를 해당 버전으로 갱신해 추가하고 **이전 버전의 문서 쌍은 계속 보관**합니다. 과거 버전의 기록을 현재 검증 결과처럼 고치거나 소급해서 만들지 않습니다.
- 루트 `README.md`와 `AGENTS.md`는 GitHub와 작업 도구가 최신 문서를 찾는 링크만 둡니다. 새 버전을 추가할 때 두 진입점도 함께 바꿉니다. 문서 본문을 중복하지 않습니다.
- 작업이 끝나면 현재 버전 문서에 확정된 사용법·규칙·최종 검사 결과·남은 제한만 반영합니다. 날짜별 작업 일지, 완료한 계획, 인계 문서, 별도 검증 보고서·JSON, 릴리즈 MD를 추가하지 않습니다. 중간 보고서를 완료 표시하거나 다른 폴더에 보관하지 말고 삭제합니다.
- 패치 노트는 GitHub Release 본문에 작성합니다. 저장소에는 같은 변경 목록을 복제하지 않습니다. 문서와 규칙은 Git으로 관리하며 요청된 커밋·푸시 범위를 마무리합니다. 생성물과 사용자 DB·비밀정보는 커밋하지 않습니다.
- `docs/assets/`에는 실제 문서와 앱에서 사용하는 화면 이미지만 둡니다. 이전 버전 문서가 참조하는 이미지는 유지하고, 달라진 화면은 버전을 구분하는 새 이름으로 추가합니다. 라이선스·저작권 고지와 소스·시험 fixture·런타임 자산은 문서 수 제한이나 작업 흔적 삭제 대상이 아닙니다.

## 산출물은 작업 중에만 사용

- `release/`는 **임시 작업 공간**입니다. 빌드 앱은 `release/builds/`, 검증 자료는 `release/checks/`, 게시 준비 파일은 `release/packages/`, 설치 교체 중의 임시 복구본은 `release/backups/`를 사용합니다. 기존 빌드 도구·CI가 `release/` 루트에 출력하는 파일도 같은 임시 산출물입니다.
- 검증·게시·복구에 필요한 동안에만 산출물을 사용합니다. 작업 종료 시 최종 결과를 문서에 반영한 뒤 성공·실패 빌드, 설치 파일 복사본, 로그, 스크린샷, trace, 임시 프로필과 작업용 복구본을 삭제하고, 사용을 마친 `release/` 자체도 제거합니다. 최신 1개·직전 버전·실패·`KEEP.md`라는 이유만으로 남기지 않습니다. 다른 경로로 옮겨 흔적을 보관하지 않습니다.
- 게시 전 설치 파일은 검증한 바이트 그대로 유지해야 합니다. 공개 다운로드의 크기·SHA-256까지 확인한 뒤 로컬 복사본을 삭제합니다. 게시 전 파일을 삭제하거나 다시 빌드한 파일을 같은 검증 결과로 게시하지 않습니다. 다음 작업은 필요한 산출물을 새로 만듭니다.
- 삭제 전 실행 중인 앱·빌드·검사·마운트된 설치 이미지를 확인합니다. 다른 작업이 사용하는 경로는 그 작업이 끝날 때까지 건드리지 않습니다. 사용자가 실행을 요청해 사용 중인 미리보기도 사용 종료 후 삭제합니다.
- 설치 앱과 실제 사용자 데이터는 `release/` 정리와 별개입니다. 설치 교체가 끝나지 않았거나 복구 중이면 복구본을 먼저 지우지 않습니다. 앱 데이터 폴더의 자동 백업·마이그레이션 백업은 개발 작업 흔적이 아닙니다.
- 정리 범위는 `release/`에 한정하지 않습니다. 사용을 마친 `dist/`, `build/icon.png`·`icon.ico`, `build/runtime-downloads/`, 작업 전용 `build/toolchains/`도 삭제합니다. 다른 폴더로 옮겨 보관하지 않습니다. 다음 개발·검증 시 도구를 준비하고 다시 빌드합니다.
- `build/installer.nsh`는 Windows 설치 스크립트 소스이고 `assets/app-icon.png`는 앱·빌드·매뉴얼이 직접 참조하는 아이콘 원본이므로 유지합니다. 폴더 이름만 보고 소스까지 일괄 삭제하지 않습니다. 시스템에 설치된 공용 개발 도구는 저장소 작업용 산출물과 구분합니다.
- 임시 Mac 앱을 남겨 사용해야 하는 동안에는 앱 묶음에 `alfred:ignore` 태그를 적용합니다. 검증 앱을 안내하는 `release/builds/Passport.app`은 상대 링크만 사용하고 앱 복사본을 늘리지 않습니다. 링크도 작업 종료 때 삭제합니다.

## 사용자 매뉴얼 작성

매뉴얼 제목은 **Passport 사용자 매뉴얼**로 유지합니다. 처음 설치한 사용자가 다음 메뉴와 버튼을 찾고 결과를 확인할 수 있도록 한국어 존댓말로 씁니다. 실제 메뉴·버튼은 굵게 표시하고 조작은 **진입 위치 → 입력·선택 → 저장·확인 → 결과** 순서로 안내합니다. 구현의 메뉴·버튼·저장 결과와 대조하며 계획을 구현된 기능으로 쓰지 않습니다.

설치, 화면과 메뉴, 로컬 셸·AI·프로파일, CLI, SSH·분할, 붙여넣기, 파일 전송, 쪽지, 템플릿, 알림·외형·단축키, 백업, 업데이트, 문제 해결을 유지합니다. 새 기능만 남기며 기본 사용법을 지우지 않습니다. 플랫폼별 설치 파일이 다르면 실제 파일이 있는 릴리즈로 연결합니다.

로컬 경로 입력과 SSH 업로드, 이미지 경로 입력과 AI의 이미지 해석, 붙여넣기와 Enter 실행, 템플릿과 실행 중인 프로세스, 수동 내보내기와 자동 동기화를 구분합니다. 삭제·복원·충돌 처리와 실제 제한은 해당 조작 옆에 안내합니다. 개발 설정·검사 수·해시는 이 AI 문서에 둡니다.

화면은 실제 앱의 격리된 예제 데이터로 촬영하고 촬영 버전을 매뉴얼에 밝힙니다. 사용자 DB·서버·인증·키·쪽지 내용을 쓰지 않습니다. `npm run docs:screenshots`는 임시 프로필과 루프백 fixture를 사용합니다. 촬영 후 개인정보·배치·원본 링크를 확인하고 촬영 로그·임시 프로필은 삭제합니다. 현재 매뉴얼 전체 화면은 1.3.1 최종 Mac 앱, 앱 내부 쪽지 가이드의 두 부분 화면은 1.3.1 Windows UI에서 촬영했습니다.

문구·링크·배치만 바꾸면 상대 링크·앵커·이미지와 `git diff --check`를 확인합니다. 문서 변경 때문에 전체 빌드·E2E·원격 Actions를 반복하지 않습니다.

## 개발 환경과 명령

저장소·앱·버전·lockfile은 하나입니다. 대상은 **macOS 14 이상 Apple Silicon, Windows 11 x64**입니다. Linux 데스크톱과 Intel Mac은 대상이 아닙니다. Node.js 24 이상·npm·stable Rust를 사용합니다. Mac은 Xcode Command Line Tools, Windows는 Python·Visual Studio C++·Windows SDK·Spectre 완화 라이브러리가 필요합니다. Windows 셸 검사는 Windows PowerShell 5.1과 PowerShell 7을 구분합니다.

```sh
npm ci
npm run build:helper
# Windows에서만
npm run prepare:runtime -- x64
npm run dev
```

| 목적 | 명령 |
| --- | --- |
| 타입 검사·컴파일 | `npm run build` |
| 타입·단위·통합 검사 | `npm run check` |
| 설치 없이 실행할 개발 앱 | `npm run pack:dev` |
| 배포 정책·게시 회귀 | `npm run test:release` |
| 빌드 후 숨김 E2E | `npm run test:e2e` |
| 기존 빌드의 특정 E2E | `node scripts/e2e.mjs <spec>` |
| 릴리즈 기본 검사 | `npm run release:check` |
| 게시할 수 없는 숨김 미리보기 검증 | `npm run release:verify -- --preview` |
| 게시 계획만 확인 | `npm run release:publish -- --manifest release/checks/<실행-ID>/verification.json` |

`npm run dev`와 `pack:dev`는 `Passport-dev`, `<버전>-dev`, `io.passport.desktop.dev`를 사용하고 정식 앱 데이터와 분리합니다. 메인·preload 변경 후에는 개발 앱을 다시 시작합니다. `npm ci`의 postinstall은 Electron ABI용 네이티브 모듈과 ssh2·node-pty 패치를 준비합니다. 일반 Node ABI 바이너리와 섞지 않습니다.

Rust·GitHub CLI는 환경에 설치된 도구를 사용합니다. 작업 중 격리된 도구가 필요하면 ignored `build/toolchains/`를 임시로 사용할 수 있으나 작업 종료 후 삭제합니다. 격리 Rust는 `CARGO_HOME`, `RUSTUP_HOME`, `PASSPORT_CARGO`를 실제 설치 위치에 맞게 지정하며, 이전 작업의 도구가 남아 있다고 가정하지 않습니다.

검사는 변경 범위에 맞게 실행합니다. Docker SSH·장시간 부하·네이티브 데스크톱 검사를 일반 문서 수정에 덧붙이지 않습니다. Docker 검사 결과도 `release/checks/docker-ssh/results.json`에 임시 출력하고 작업 종료 후 삭제합니다.

## 구현 계약

### 프로세스·플랫폼 경계

- 메인이 세션·SSH·PTY·파일·터널·전송·DB를 소유합니다. renderer는 Node 접근 없이 sandbox·contextIsolation·CSP를 유지하고 제한된 preload IPC만 사용합니다. 메인은 송신 창·메인 프레임·Zod 입력·세션 소유권을 검사합니다.
- `src/main/platform/contracts.ts`는 타입 계약, `index.ts`는 유일한 OS 선택 지점입니다. `darwin`·`win32` 구현은 서로 import하지 않으며 import 시 OS 조회·프로세스·소켓 부작용을 만들지 않습니다. renderer에서 main/platform을 import하지 않습니다.
- OS 기능만 분리하고 공통 세션·IPC·DB·프로파일 정책·셸 시작 문법을 OS별로 복제하지 않습니다. 계약 변경은 두 OS 구현·호출부·시험과 이 문서를 같은 변경에서 갱신합니다.
- 플랫폼을 주입한 단위 검사를 다른 OS의 실기 검증으로 표시하지 않습니다. 실행하지 못한 OS는 검증 대기로 적습니다.

### 터미널·수명·입력

- 각 PTY 인스턴스·세대를 구분해 이전 연결의 콜백이 새 연결을 바꾸지 않게 합니다. 미처리 출력 256 KiB에서 읽기를 멈추고 renderer의 xterm 쓰기 완료 ACK 뒤 재개합니다. 탭 이동·창 이동 중 버퍼와 출력 순서·소유권을 보존합니다.
- `pendingExits`에서 실제 네이티브 종료 콜백 반환까지 추적합니다. 앱 종료는 PTY 정리 후 DB·Electron 순서이며, 강제 종료로 정상 종료 검사를 통과시키지 않습니다. Windows 자식 프로세스는 job object로 관리하고 POSIX 시그널을 보내지 않습니다. ConPTY 패치 소스 해시와 강제 빌드를 유지합니다.
- `terminal-unicode.ts`의 공식 Unicode 11 addon을 첫 출력·스냅샷 전에 적용합니다. 로컬·SSH·일반/대체 화면·창 이동에 같은 규칙을 사용합니다. 임의 폭 표나 사용자 셸 설정 변경으로 우회하지 않습니다.
- 파일·이미지·텍스트 클립보드 우선순위를 유지하고 비동기 작업 전후에 소유 창·세션 세대를 재검사합니다. 파일 읽기는 3초 timeout·4 MiB maxBuffer·Windows 숨김 실행을 유지합니다. 셸 문자열 보간으로 경로를 실행하지 않습니다. Mac 검사는 별도 named pasteboard를 사용합니다.
- 파일 드롭은 preload의 실제 경로와 main 검증을 거쳐 클립보드와 같은 인용·패널별 입력 큐를 사용합니다. 원본 경로만 입력하며 Enter·복사본·SSH 업로드를 만들지 않습니다. Shift+Enter·IME·일반 Enter를 구분합니다.
- 시작 프로파일은 사용자 셸 파일·CLI 설정·신뢰 정책을 덮어쓰지 않습니다. Windows Bash GUI 검사는 실제 다음 프롬프트까지 기다립니다. PTY 연결·직전 명령 결과·OSC 신호만으로 입력 준비 완료를 판정하지 않습니다.

### 창·저장·보안

- Windows 창은 AppUserModelID → `show: false` 생성 → ICO·setAppDetails → ready-to-show → 표시 순서입니다. 숨김 E2E 정책을 마지막에 적용해 표시 옵션이 덮어쓰지 못하게 합니다.
- 외부 링크는 메인이 소유권·HTTP/HTTPS URL을 검사하고 실제 주소 확인 후 `openExternal` 직전에 다시 검사합니다. 외부 탐색·임의 창·권한 요청을 차단합니다.
- SQLite 스키마는 5, 문서·portable 형식은 2입니다. 이행 전 백업과 구버전 쓰기 차단을 유지합니다. 여러 창의 문서는 현재 revision으로 저장합니다. 템플릿은 탭 하나만 복사하고 프로세스·AI 대화는 보관하지 않습니다.
- 실제 데이터는 Mac `~/Library/Application Support/Passport`, Windows `%APPDATA%/Passport`입니다. 시험은 `PASSPORT_DATA_DIR` 등으로 격리하고 사용자 DB·셸 설정·일반 클립보드를 변경하지 않습니다. OS safeStorage 실패 시 인증 정보를 평문으로 저장하지 않습니다.
- 쪽지는 TLS 1.3·기기 지문 고정·상호 인증, 등록 승인과 요청별 수신 승인을 유지합니다. 수신 파일의 확장자·크기·해시·경로와 OS quarantine/Internet Zone 보호가 실패하면 공개하지 않습니다. 자동 열기·실행·AI 전달을 추가하지 않습니다. CLI는 등록·수신 승인·받은 본문 읽기를 제공하지 않습니다.
- 터미널·쪽지 CLI의 토큰은 새 로컬 PTY에 상속하며 로그·fixture·문서로 꺼내지 않습니다. 요청 성공과 상대 프로그램의 작업 완료를 구분하고 `DELIVERY_UNKNOWN`을 자동 재전송하지 않습니다.
- SSH·SFTP·터널의 인증·호스트 지문 검증은 공유합니다. FTPS 인증서 검증을 끄지 않습니다. 파일 전송은 임시 파일·크기 검사·최종 이름 전환·실패 복구를 유지합니다.
- 공용 원본은 `assets/`에서 관리합니다. 앱 아이콘은 `assets/app-icon.png`, 라이선스·출처 원문은 `assets/licenses/`에 둡니다. 앱 내부 쪽지 가이드가 `docs/assets/notes-compose.png`, `notes-pending.png`를 import하므로 문서 정리 때 삭제하지 않습니다. `THIRD_PARTY_NOTICES.md`와 글꼴 출처도 배포에 필요한 고지입니다.

## E2E는 하나의 시험 집합

GUI E2E 소스는 **`tests/e2e/` 하나**입니다. 릴리즈 검증은 같은 시험을 소스와 최종 설치 파일에서 각각 실행해 포장 과정까지 확인합니다. `tests/release.test.mjs`는 Node 기반 게시 조건·해시·manifest·종료 판정 회귀이며 별도 GUI E2E 복제본이 아닙니다. 시험 코드는 유지하고 실행 결과만 정리합니다.

로컬 실행은 기본 숨김 모드이며 창 표시·네이티브 포커스를 차단합니다. 사용자에게 **창 표시 또는 실제 데스크톱 검사 요청을 명시적으로 받은 경우에만** `--show`, `--desktop`, `test:e2e:show`, `test:e2e:desktop`을 사용합니다. 일반 수정·검증 요청을 허용으로 해석하거나 검사 필요를 이유로 자동 전환하지 않습니다. 하지 못한 데스크톱 검사는 대기로 기록합니다.

`playwright.config.ts`는 worker 1개, `fullyParallel: false`입니다. 각 파일은 독립 실행할 수 있어야 합니다. 파일·describe 안에서 초기화 가능한 UI는 `reusableApp()`으로 앱과 기본 창을 재사용합니다. 종료·재시작·시작 환경·CLI 환경 상속·복잡한 전송과 쪽지의 두 앱 검사는 독립 수명을 유지합니다. 전체 파일을 전역 앱 하나로 묶지 않습니다.

재사용 fixture는 등록 시 한 번 호출하고 `beforeAll` 이후에 앱·page를 읽습니다. 사례마다 초기 상태를 직접 준비하고 본문에서 공유 앱이나 기본 창을 종료하지 않습니다. 복구 순서는 다음과 같습니다.

1. PID·기본 창을 확인하고 네이티브 API의 원래 descriptor·IPC handler를 복구합니다. 특히 `net.fetch`는 reload 전에 복구합니다.
2. 사례의 dialog·request·pageerror 리스너를 제거하고 오류 수집기를 재연결합니다.
3. 기존 bootstrap/save IPC와 현재 revision으로 최초 문서를 복원합니다. 제거된 연결은 제품의 정상 정리를 거칩니다.
4. 시험용 활동·로그·인증·storage·paste-images를 비우고 추가 창을 닫으며 기본 창을 1440×900으로 복구합니다.
5. 같은 PID·기본 창에서 renderer만 reload하고 초기 문서·빈 상태·오류 없음·표시/포커스 0을 검사합니다.

새 mock·리스너·전역 상태·진행 중 promise를 추가하면 직접 정리하거나 fixture 복구 계약과 `tests/e2e/reuse.spec.ts`를 함께 갱신합니다. clipboard·dialog·openExternal·net.fetch·execFile·isFocused/isVisible·Date.now·passport:call의 원상복구를 유지합니다. 서버·named pasteboard 등 외부 자원은 사례가 정리합니다. Windows 임시 사용자 프로필에는 Downloads도 먼저 만듭니다.

실행 중 `lifecycle.jsonl`·`artifact.json`으로 **launches = exits = auditedShutdowns**, 숨김 표시·네이티브 포커스 **0회**를 확인합니다. 정상 종료는 코드 0·시그널 없음이며 10초 종료 제한을 유지합니다. 네이티브 정리를 기다린 뒤 디버거를 분리합니다. Windows 잔류 프로세스 감사는 시작 전에 있던 프로세스를 제외하며 조회 실패도 실패로 처리합니다. 최종 요약을 문서에 남기면 원본 로그는 삭제합니다.

GUI 파일·제목·플랫폼·모드를 바꾸면 `tests/e2e/release-policy.json`과 배포 회귀를 함께 갱신합니다. 필수 시험 생략·재시도 추가·전역 timeout 확대로 통과시키지 않습니다. 부분 검사·전체 검사, 모의 API·루프백·다른 PC의 LAN·물리 IME·OS 권한 실기를 구분합니다.

## 검증과 GitHub 게시

정식 배포는 깨끗한 동일 소스 커밋·버전에서 양쪽 OS를 각각 검증합니다. 실제 데스크톱 검사를 허용받았다면 `npm run release:verify -- --desktop`을 사용합니다. preview 결과는 게시할 수 없습니다. 소스 및 최종 설치본의 필수 GUI, 종료·서명·자산·체크섬 검증을 통과해야 합니다.

검증 manifest로 게시 계획을 확인한 뒤 사용자가 게시를 요청한 범위에서 `release:publish`에 `--execute`를 추가합니다. 검증된 설치 파일을 재빌드하지 않습니다. 공개 다운로드까지 크기·SHA-256을 대조하고 검증 소스 커밋·태그·결과·남은 제한을 이 문서에 기록한 뒤 임시 산출물을 삭제합니다. 문서 마무리 커밋은 배포 소스와 구분하며 기존 태그를 옮기지 않습니다.

기존 GitHub Release 본문은 보존합니다. 새 릴리즈에 본문이 없으면 게시 도구가 GitHub 자동 노트를 생성하며 필요한 설명은 GitHub 본문에서 편집합니다. 로컬 릴리즈 MD를 게시 조건으로 요구하지 않습니다. 기존 플랫폼 자산·체크섬을 덮어쓰거나 1.1.1용 과거 예외 규칙을 새 버전에 적용하지 않습니다.

`.github/workflows/desktop.yml`은 수동 진단용입니다. 문서 커밋이나 일반 검증 요청만으로 원격 Actions·새 릴리즈·태그·설치본 교체를 실행하지 않습니다. Mac 현재 배포는 ad-hoc 서명이며 Apple 공증이 없습니다. Developer ID 배포는 `CSC_NAME`을 지정한 별도 signed 설정과 공증 검증이 필요합니다.

## 최종 상태와 남은 제한

| 항목 | 확정 결과 |
| --- | --- |
| Mac 공개판 | [v1.3.2](https://github.com/poyal/passport/releases/tag/v1.3.2), 소스 `079466bcd8228a26ecb8d5e2a3f52575152d3bf5` |
| Windows 공개판 | [v1.3.1](https://github.com/poyal/passport/releases/tag/v1.3.1), 소스 `63f4897f69d9a76468f77d1127d474dbd2598a86`; 1.3.2 네이티브 검증·게시 대기 |
| Mac 1.3.2 단위·통합 | 240 통과, 플랫폼·선택 검사 7 생략 |
| Mac 1.3.2 배포 정책 | 공개 소스 기준 73 통과 |
| Mac 1.3.2 소스·최종 DMG GUI | 각각 숨김 84 통과·정책상 9 생략, 사용자 허용 후 실제 데스크톱 각각 4 통과 |
| Mac 1.3.2 숨김 수명 | 실행별 시작·정상 종료·감사 각각 34회, 표시·네이티브 포커스 0회, 실패·재시도 없음 |
| Mac 1.3.2 배포 파일 | 173,591,840 바이트, 공개 다운로드·체크섬·ad-hoc 서명·실제 PTY/helper 확인 |
| 양쪽 OS 1.3.1 실기 | 같은 소스에서 LAN·등록/수신 승인·암호화 저장(Keychain/DPAPI)·quarantine/Zone 보호 확인, VPN 제외 |
| 문서·게시 도구 정리 | 로컬 릴리즈 MD 의존성 제거, 기존 GitHub 본문 유지 회귀 포함 배포 정책 74 통과. 공개 바이너리와 별도 소스 변경 |

Mac 1.3.2 DMG SHA-256: `b8beb3e6aab221310e5ca83e9c46a691a4070390e114519c53f9ba003c008a9d`.

[이슈 #7](https://github.com/poyal/passport/issues/7)의 `💻`·`🔧` 프롬프트 잔상·커서 위치 불일치는 Mac 1.3.2에서 수정·배포되어 해결 상태로 닫았습니다. 확대 검사 86개 중 81개는 정상이지만, 긴 국기·분해 한글·ZWJ 프롬프트 3개와 분해 한글 입력·붙여넣기 2개는 미해결이며 [후속 이슈 #8](https://github.com/poyal/passport/issues/8)에서 추적합니다. 일반 이모지 폭 수정으로 모든 복합 문자가 해결됐다고 쓰지 않습니다.

이전 Electron 종료 지연·사용자 셸 초기화 지연의 최초 원인은 미확정이며 후속 성공만으로 원인 해결을 단정하지 않습니다.

물리 IME·실제 AI 서비스·OS 알림·깨끗한 계정의 설치/업그레이드·macOS 14 실기·Developer ID/공증은 위 자동 검사 성공과 별개입니다. 남은 제한은 문서와 이슈로 관리하고 완료한 작업의 실패 앱·중간 로그를 보존하는 근거로 쓰지 않습니다.
