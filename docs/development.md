# Passport 공통 개발 규칙

모든 버전에 공통으로 적용하는 환경 준비·구현 계약·검사·문서 관리 규칙입니다. 현재 소스에 맞춰 이 문서를 갱신하며 릴리즈 버전 폴더에 복제하지 않습니다. AI 작업의 기본 지침은 [루트 AGENTS](../AGENTS.md), 설치 파일 검증·게시 절차는 [릴리즈 가이드](release.md)를 따릅니다. 사용자 조작 설명은 [루트 README](../README.md), 버전별 검증 결과·남은 제한은 [문서 안내](README.md)의 해당 버전 AI 기록에서 확인합니다.

## 환경 준비

저장소·앱·버전·lockfile은 하나이며 대상은 **macOS 14 이상 Apple Silicon과 Windows 11 x64**입니다. 각 OS의 네이티브 빌드 환경을 사용합니다. 다른 OS·아키텍처에서 만든 네이티브 모듈을 가져와 재사용하지 않습니다.

| 공통 | macOS | Windows |
| --- | --- | --- |
| Node.js 24 이상, npm, Git, stable Rust | arm64 Node, Xcode Command Line Tools, Rust `aarch64-apple-darwin` 대상 | x64 Node, Python, Visual Studio C++ 빌드 도구·Windows SDK·Spectre 완화 라이브러리, Rust `x86_64-pc-windows-msvc` 대상 |
| FTP/FTPS 검사: Python 3·OpenSSL | `python3`, `openssl`을 PATH에서 실행할 수 있어야 함 | `python`, `openssl`, Windows PowerShell 5.1 및 PowerShell 7 필요 |

Windows 정식 검증은 `%ProgramFiles%/PowerShell/7/pwsh.exe`와 PATH의 `pwsh`를 모두 확인합니다. OpenSSL이 없다면 설치된 Git for Windows의 `usr/bin` 경로를 확인해 PATH에 추가할 수 있습니다. PowerShell의 npm 스크립트 실행 정책에 걸리면 `npm.cmd`를 사용합니다. Python·컴파일러·SDK가 필요한 네이티브 의존성 설치 오류를 무시하지 않습니다.

시스템에 설치된 Rust·GitHub CLI 등 공용 도구를 사용합니다. 작업 전용 설치가 필요하면 ignored `build/toolchains/`를 사용하고 작업 종료 후 삭제합니다. 별도 Rust 설치는 `CARGO_HOME`, `RUSTUP_HOME`, `PASSPORT_CARGO`를 실제 위치에 맞게 설정합니다. 이전 작업의 도구가 남아 있다고 가정하지 않습니다.

```sh
npm ci
npm run build:helper
# Windows에서만: 내장 Bash 준비
npm run prepare:runtime -- x64
npm run dev
```

`npm ci`의 postinstall은 ssh2 패치, Electron ABI용 `better-sqlite3`·`node-pty`, Windows ConPTY 패치를 준비합니다. 설치 실패를 `--ignore-scripts`나 `npmRebuild: false`로 우회하지 않습니다. Rust helper 빌드는 Cargo.lock을 적용하고 앱 버전과 의존 라이선스를 함께 생성합니다. `npm run build`에도 helper 빌드가 포함됩니다.

개발 앱은 `Passport-dev`, `<버전>-dev`, `io.passport.desktop.dev`로 정식 앱 데이터와 분리됩니다. 패키징하지 않은 모든 실행(`npm start`·`electron .` 포함)은 환경 변수 유무와 관계없이 개발 식별자를 사용해 Windows 바로가기와 사용자 DB가 정식 앱에 연결되지 않게 합니다. renderer는 개발 중 갱신되지만 main·preload 변경 후에는 앱을 다시 시작합니다. 시험은 `PASSPORT_DATA_DIR` 등 격리 경로를 사용하며 실행 중인 사용자의 DB·셸 설정·일반 클립보드를 수정하지 않습니다.

## 폴더와 빌드 결과

| 경로 | 역할 |
| --- | --- |
| `src/main/` | 세션·SSH·PTY·DB·인증·파일 전송·터널·IPC 소유 |
| `src/main/platform/` | macOS·Windows의 OS 계약과 구현 |
| `src/preload/`, `src/renderer/`, `src/shared/` | 제한된 IPC bridge, React·xterm UI, 공통 스키마·키·배치 |
| `native/helper/` | Rust helper·Passport CLI의 소스, Cargo.toml·Cargo.lock |
| `resources/terminal/runtime-manifest.json` | 내장 Portable Git의 버전·출처·해시·시작 파일 패치 명세 |
| `assets/` | 앱 아이콘 원본과 `assets/licenses/`의 라이선스·출처 원문 |
| `src/renderer/assets/` | renderer 전용 SVG 등 UI 자산; `src/assets/`는 사용하지 않음 |
| `build/installer.nsh` | Windows NSIS 설치 스크립트 **소스** |
| `scripts/`, `tests/` | 개발·검증·게시 자동화와 시험 소스 |
| `docs/` | 작업 가이드·버전별 최종 문서·사용 중인 화면 이미지 |

`native/helper/`는 Rust 프로젝트, `resources/terminal/`은 패키징 입력을 모으는 현재 경로입니다. 도구가 강제하는 위치는 아니지만 변경할 때는 `scripts/build-helper.mjs`, `scripts/prepare-runtime.mjs`, `scripts/check-resources.cjs`, `package.json`의 extraResources, `src/main/shells.ts`, 시험·ignore·문서를 함께 맞춰야 합니다. 설치된 앱 내부의 `terminal/` 경로와 저장소 경로도 구분합니다.

아래는 원본과 달리 다시 만들 수 있는 생성물입니다. 작업 중에는 사용하되 [산출물 정리 규칙](release.md#산출물-정리)에 따라 종료 시 삭제합니다.

- `dist/`: 컴파일 결과.
- `native/helper/target/`: Rust 컴파일 결과와 캐시.
- `resources/terminal/helper/`: 패키징용 helper·CLI·자동 수집 라이선스 복사본.
- `resources/terminal/runtime/`: 해시를 검증하고 패치한 Portable Git 런타임.
- `build/icon.png`·`icon.ico`, `build/runtime-downloads/`, 작업 전용 `build/toolchains/`.
- `release/`, `test-results/`, `test-results-stress/`, `playwright-report/`, `coverage/`: 작업·시험 결과.

## 개발 명령과 검사 선택

명령은 저장소 루트에서 실행합니다.

| 목적 | 명령 | 범위 |
| --- | --- | --- |
| 컴파일 | `npm run build` | TypeScript·Rust helper·앱 번들 |
| 타입·단위·통합 검사 | `npm run check` | 타입 검사 후 Electron 런타임의 Vitest |
| 관련 단위 검사 | `node scripts/test.mjs tests/platform.test.ts` | 파일 인수로 범위를 좁힘 |
| 배포 정책·게시 회귀 | `npm run test:release` | `tests/release.test.mjs`; GUI 실행·실제 게시 없음 |
| 릴리즈 기본 검사 | `npm run release:check` | check와 test:release; 설치 파일 검증은 별도 |
| 숨김 GUI 전체 | `npm run test:e2e` | 빌드 후 공통 E2E 실행 |
| 빌드 후 특정 GUI | `node scripts/e2e.mjs tests/e2e/reuse.spec.ts` | 현재 dist 사용; 소스 변경 뒤에는 먼저 빌드 |
| 설치 없는 개발 앱 | `npm run pack:dev` | `release/builds/<실행-ID>/`에 Passport-dev 생성 |
| 게시 불가 배포 리허설 | `npm run release:verify -- --preview` | 숨김 검사·패키징·검증; 게시에는 사용할 수 없음 |

단위 검사는 Electron ABI 네이티브 모듈을 사용하므로 `scripts/test.mjs`가 Electron을 Node 모드로 실행합니다. 일반 Node에서 `npx vitest`만 실행한 결과로 대체하지 않습니다. 테스트 fixture의 localhost listen이 차단되면 환경을 바로잡고, 이를 기능 실패나 통과로 기록하지 않습니다.

변경한 계약의 단위 검사와 관련 GUI를 먼저 수행합니다. 예를 들어 플랫폼 변경은 `tests/platform.test.ts`·`tests/runtime.test.ts`, 입력은 `tests/paste.test.ts`·`tests/terminal-unicode.test.ts`, PTY 종료는 `tests/windows-pty.test.ts`와 `tests/e2e/shutdown.spec.ts`를 함께 검토합니다. 릴리즈 검증은 관련 부분 검사로 대체하지 않습니다. **문구·링크·배치만 바꾼 경우는 문서 확인만 수행합니다.**

### FTP·FTPS와 선택 검사

일반 단위 검사에서 `FTP_TEST_PYTHON`이 없으면 FTP fixture 검사가 생략됩니다. 이를 실행하려면 다음과 같이 준비합니다. 정식 릴리즈 검증은 이 준비와 검사를 필수로 수행합니다.

```sh
# macOS
python3 -m venv release/checks/dev-ftp/python
release/checks/dev-ftp/python/bin/python -m pip install -r tests/fixtures/requirements.txt
FTP_TEST_PYTHON="$PWD/release/checks/dev-ftp/python/bin/python" npm run check
```

```powershell
# Windows PowerShell
python -m venv release/checks/dev-ftp/python
& ./release/checks/dev-ftp/python/Scripts/python.exe -m pip install -r tests/fixtures/requirements.txt
$env:FTP_TEST_PYTHON = (Resolve-Path 'release/checks/dev-ftp/python/Scripts/python.exe').Path
npm.cmd run check
Remove-Item Env:FTP_TEST_PYTHON
```

FTPS는 OpenSSL을 이용해 시험 인증서를 만듭니다. 인증서 검증을 꺼서 통과시키지 않습니다.

`npm run test:ssh:docker`는 실행 중인 Docker 엔진·네트워크·여유 저장 공간이 필요합니다. 임시 인증과 루프백 포트로 OS별 SSH/SFTP/터널·GUI 전송을 검사하며 해당 실행의 컨테이너만 정리합니다. 결과 기본 경로는 `release/checks/docker-ssh/results.json`입니다. 구형 알고리즘 fixture의 성공을 실제 모든 구형 OS에서 검증한 것으로 쓰지 않습니다.

`PASSPORT_STRESS=1 node scripts/test.mjs tests/stress.test.ts`는 대용량 파일·다수 파일을 검사합니다. `PASSPORT_UI_STRESS=1 node scripts/e2e.mjs tests/e2e/stress.spec.ts`는 지속 UI 부하, `npm run test:terminal:large`는 대용량 텍스트 처리 검사입니다. Windows에서는 해당 환경 변수를 `$env:변수명 = '1'`로 설정하고 실행 후 해제합니다. 일반 문서 수정에 선택 검사를 덧붙이지 않으며, 실행 범위·지속 시간·기기를 최종 결과에 명시합니다. 원본 JSON·로그를 docs에 보관하지 않습니다.

`PASSPORT_NATIVE_AI=1 node scripts/e2e.mjs tests/e2e/native-agent-resume.spec.ts`는 PATH에 설치된 실제 Codex·Claude CLI로 대화 생성, 실행 옵션 보존, 앱 완전 종료·재시작 후 동일 대화 재개와 빈 Claude 재실행을 검사합니다. 앱 DB·셸 시작 파일·AI 설정·대화 저장 폴더를 격리하고 모델 응답만 루프백 서버로 제공합니다. Electron 프로세스의 HOME·USERPROFILE은 유지합니다. macOS에서 HOME을 임시 폴더로 바꾸면 Keychain을 찾지 못하고 생성·재설정 요청을 띄울 수 있으므로 이 방식으로 앱을 격리하지 않습니다. 실제 CLI·훅·대화 파일 검증이며 유료 API·로그인·외부 모델 서비스 검증은 아닙니다. Codex의 훅 신뢰는 격리 프로필의 기본 검토 화면에서 승인합니다. CLI가 없거나 동작이 달라지면 요청한 검사는 실패하며 모의 CLI로 대체하지 않습니다.

## E2E 실행과 작성

GUI 시험 소스는 **`tests/e2e/` 하나**입니다. 릴리즈는 같은 시험을 소스 앱과 최종 설치 파일에서 각각 실행합니다. `tests/release.test.mjs`는 manifest·해시·GUI 판정·게시 정책을 검사하는 Node 회귀 시험이며 별도의 GUI E2E가 아닙니다.

로컬 E2E 기본은 `hidden`입니다. 창 생성부터 표시·네이티브 포커스를 막으며 일반 Playwright 입력은 계속 검사합니다. 숨김 모드도 Electron 데스크톱 세션은 필요합니다. 사용자가 창 표시·실제 데스크톱 검사를 **명시적으로 요청한 경우에만** 다음 모드를 사용합니다.

| 모드 | 명령 | 의미 |
| --- | --- | --- |
| hidden | `npm run test:e2e` | 표시·네이티브 포커스 없이 일반 GUI 검사 |
| passive | `npm run test:e2e:show` | 창 표시, 네이티브 포커스 차단 |
| desktop | `npm run test:e2e:desktop` | `@desktop` 실제 포커스·클립보드 검사 |

빌드된 앱에는 `node scripts/e2e.mjs [--show 또는 --desktop] <spec>`을 사용할 수 있습니다. `PASSPORT_E2E_EXECUTABLE`에 검증할 패키지의 실행 파일 절대 경로를 지정하면 격리 데이터로 그 앱을 검사합니다. 숨김 모드를 지원하지 않는 예전 바이너리는 실행 전에 거부하며 자동으로 창 표시 모드로 바꾸지 않습니다. 설치된 사용자 앱을 임의로 교체하지 않습니다.

### 앱 재사용과 복구 계약

Playwright worker는 1개이며 `fullyParallel: false`입니다. 각 파일은 독립 실행 가능해야 합니다. 파일·describe 안에서 초기화 가능한 UI 사례는 `tests/fixtures/reusable-app.ts`의 `reusableApp()`으로 앱과 기본 창을 재사용합니다. 종료·재시작·시작 환경·CLI 환경 상속·복잡한 전송·쪽지의 두 앱 검사는 독립 실행을 유지합니다.

fixture는 테스트 등록 시 한 번 호출하고 `beforeAll` 이후에 앱·page를 읽습니다. 각 사례는 자신의 초기 상태를 준비하며 공유 앱·기본 창을 본문에서 종료하지 않습니다. 사례 사이의 복구는 다음 순서를 유지합니다.

1. PID·기본 창을 확인하고 네이티브 API descriptor와 IPC handler를 복원합니다. `net.fetch`는 renderer reload 전에 복원합니다.
2. 사례가 추가한 dialog·request·pageerror 리스너를 제거하고 오류 수집기를 다시 연결합니다.
3. 정상 bootstrap/save IPC와 현재 revision으로 최초 문서를 복원합니다. 제거된 연결은 제품의 정상 정리를 거칩니다.
4. 시험 활동·로그·인증·storage·paste-images를 비우고 추가 창을 닫으며 기본 창을 1440×900으로 되돌립니다.
5. 같은 PID·기본 창에서 renderer만 reload하고 문서·빈 상태·오류 없음·표시/포커스 0을 검사합니다.

새 mock·리스너·지속 상태·진행 중 promise를 추가하면 직접 정리하거나 복구 fixture와 `tests/e2e/reuse.spec.ts`를 함께 갱신합니다. clipboard·dialog·openExternal·net.fetch·execFile·isFocused/isVisible·Date.now·passport:call 복원을 유지합니다. 서버·named pasteboard 같은 외부 자원도 사례가 정리합니다. Windows의 격리 사용자 프로필에는 Electron 실행 전에 Downloads 폴더를 준비합니다.

### 결과 판정

`scripts/e2e.mjs`는 `release/checks/<실행-ID>/`에 보고서·로그·`lifecycle.jsonl`·`artifact.json`을 만듭니다. 재사용 reset 횟수와 프로세스 실행 횟수를 구분하고 **launches = exits = auditedShutdowns**, 숨김 **shown = focused = 0**을 확인합니다. 정상 종료는 코드 0·시그널 없음이며 10초 종료 제한을 유지합니다. 종료 시 네이티브 정리 뒤 디버거를 분리합니다. 강제 종료는 정상 종료로 처리하지 않습니다.

Windows는 시험 전부터 실행 중이던 프로세스를 제외하고 잔류 PTY·자식 프로세스를 감사하며 조회 실패도 실패입니다. GUI 파일·제목·플랫폼·모드를 바꾸면 `tests/e2e/release-policy.json`을 함께 수정하고 `npm run test:release`로 판정 회귀를 확인합니다. 안정적인 시험 ID는 이름 변경 시에도 유지합니다. 필수 사례 생략·누락·재시도·전역 timeout 확대로 통과시키지 않습니다.

모의 API·루프백·실제 다른 PC의 LAN·물리 IME·OS 권한을 구분합니다. 두 앱 쪽지 fixture의 safeStorage mock 성공을 Keychain/DPAPI 실기 성공으로 기록하지 않습니다. 최종 결과만 버전 AI 문서에 반영한 뒤 실행 결과를 삭제합니다.

## 구현 경계와 플랫폼 계약

main은 세션과 데이터를 소유하고 renderer는 sandbox·contextIsolation·CSP와 제한된 preload IPC만 사용합니다. IPC에서 송신 창·메인 프레임·입력 스키마·세션 소유권을 검사합니다. 사용자 DB 경로는 Mac `~/Library/Application Support/Passport`, Windows `%APPDATA%/Passport`입니다. safeStorage 실패를 평문 인증 저장으로 우회하지 않습니다.

OS 기능은 `src/main/platform/contracts.ts`의 타입 계약과 `darwin/`·`win32/` 구현으로 나눕니다. `index.ts`가 유일한 OS 선택 지점이며 구현끼리 import하거나 renderer가 main/platform을 참조하지 않습니다. import 시 OS 조회·프로세스·소켓 부작용을 만들지 않습니다. 공통 세션·IPC·DB·셸 시작 문법을 OS별로 복제하지 않습니다. 계약 변경은 두 구현·호출부·시험·문서를 함께 갱신하고, 주입 단위 검사를 다른 OS의 실기 검사로 쓰지 않습니다.

| 계약 | 지켜야 할 동작 |
| --- | --- |
| `TerminalPlatform` | 셸 탐색·실행 파일 아키텍처·기본 인수·경로·profileKey·환경 준비·PTY 동작만 담당. `configureEnvironment`는 새 세션 환경을 수정하고 사용자 셸 파일을 덮어쓰지 않음 |
| `PtyBehavior` | PTY마다 새 인스턴스 생성. 출력은 큐에 넣기 전에 observe, input은 동기 문자열 변환이며 직접 PTY write 금지. 실제 크기 변경 때 resized 호출. terminate 반환을 네이티브 종료 완료로 보지 않음 |
| `ClipboardPlatform` | 파일 형식 없음은 `undefined`, 빈 목록은 `[]`, 읽기 실패는 reject. 파일·이미지·텍스트 순서와 비동기 전후 소유 창·세대 재검사 유지 |
| `DesktopPlatform` | Windows AppUserModelID 설정 → 숨김 생성 → ICO·setAppDetails → ready-to-show → 표시. 숨김 시험 정책을 마지막에 적용 |
| `ActivityEndpoint` | 생성 → 서버 listen → listening(권한 설정), 연결·서버 종료 → dispose. Mac 소켓과 Windows pipe 차이만 분리; DB 정책은 공통 계층에 둠 |
| `protectDownload` | Mac quarantine, Windows IAttachmentExecute의 Save와 ZoneId 3 적용 후 파일 해시 재검사. 보호 실패 시 파일 공개 중단; 자동 실행 금지 |

PTY 출력은 256 KiB 미처리에서 읽기를 멈추고 xterm 쓰기 완료 ACK 뒤 재개합니다. 세대가 다른 콜백은 새 연결을 바꾸지 못하게 하며 탭·창 이동 중 버퍼·출력 순서·소유권을 보존합니다. 종료 전 읽기를 재개하고 `pendingExits`로 네이티브 종료 콜백 반환까지 기다린 뒤 DB·Electron을 닫습니다. Windows 자식은 job object로 관리하며 POSIX 시그널을 쓰지 않습니다. ConPTY 소스 해시·강제 재빌드를 유지합니다. Windows Passport Bash의 resize 보정은 해당 세대·조건에만 적용하고 다른 셸·TUI에 퍼뜨리지 않습니다.

터미널 붙여넣기는 `session.paste`에서 소유 창·연결 세대·UTF-8 본문 4 MiB를 검사합니다. 클립보드 전체 항목과 구분 줄바꿈을 합산하고 끝 줄바꿈 제거·제어 문자 검사·줄바꿈 정규화는 분할 전에 한 번 적용합니다. main의 연결별 입력 큐는 일반 키·스니펫·CLI 입력을 포함해 순서를 유지하고, 최대 32 KiB씩 실제 쓰기 완료를 기다립니다. 본문은 진행 중을 포함해 패널당 8 MiB·앱 전체 32 MiB, 요청은 1,024개·4,096개로 제한합니다. renderer의 클립보드 읽기·IPC 접수 대기와 main의 클립보드 읽기도 각각 별도의 같은 바이트 예산을 사용하며 이 값은 프로세스 전체 메모리 상한을 뜻하지 않습니다.

`scripts/patch-pty-input.mjs`는 고정 node-pty 버전의 macOS 쓰기 큐에 부분 쓰기·오류·종료 완료 콜백을, Windows에는 준비 완료 후 입력 소켓 쓰기 콜백을 노출합니다. 의존성 준비·빌드·시험·패키징에서 적용 여부를 검사하고 알려지지 않은 구현은 실패 처리합니다. 네이티브 완료는 대상 프로그램의 처리 완료가 아닙니다. Ctrl+C는 미전송 입력을 취소하고 현재 조각 뒤에 필요한 붙여넣기 종료 구분자와 중단 키를 보냅니다. 종료·재연결 때 큐와 예약 용량을 폐기하고 이전 콜백으로 새 연결을 변경하거나 입력을 재전송하지 않습니다. 큐가 남은 탭은 창 이동을 거절합니다. SSH 연결 세대는 복원 설정과 관계없이 발급합니다.

클립보드 네이티브 읽기는 3초 timeout·4 MiB maxBuffer·Windows 숨김 실행을 유지합니다. 파일 수·경로 길이 한도와 절대 경로·NUL/CR/LF 검사를 통과해야 하며 경로를 셸 문자열에 삽입해 실행하지 않습니다. Mac 시험은 고유 named pasteboard를 사용합니다. Electron의 텍스트 읽기를 모의 처리한 경우에도 AppKit 파일 읽기 경로를 같은 시험용 pasteboard로 분리해야 합니다. 파일 드롭은 실제 경로 검증과 동일한 인용·패널별 큐를 사용하며 Enter·복사본·SSH 업로드를 추가하지 않습니다.

Unicode 11 addon은 첫 출력·스냅샷 전에 적용하며 로컬·SSH·일반/대체 화면·창 이동에 같은 규칙을 사용합니다. 기본 모드에 임의 폭 표를 적용하거나 사용자 셸 설정을 변경하지 않습니다. 명시적으로 선택한 macOS zsh 호환 모드에만 실제 zsh 5.9 재현으로 확인한 국기·분해형 한글·ZWJ 폭 차이를 적용합니다. 유효 모드는 세션과 스냅샷에 전달하며 첫 출력·복원 전에 설정하고, 모드 변경 시 화면·스크롤백을 초기화합니다. IME·일반 Enter·Shift+Enter를 구분하고 키보드 문맥은 창이 소유하며 탐색 때 초기화합니다. 시작 프로파일은 사용자 셸 파일·CLI 설정·신뢰 정책을 덮어쓰지 않습니다. 시작 준비는 실제 다음 프롬프트를 확인하고 PTY 연결이나 직전 명령 결과만으로 판정하지 않습니다.

SQLite 스키마는 7, 문서·portable 형식은 2입니다. 이행 전 백업·구버전 쓰기 차단·revision 기반 다중 창 저장을 유지합니다. 템플릿은 탭 배치·설정만 저장합니다. 쪽지는 TLS 1.3·기기 지문 고정·상호 인증·등록 및 수신 승인과 파일 검사를 유지합니다. CLI는 친구 등록 승인을 제공하지 않습니다. 수신 목록·승인·저장된 본문 읽기는 기존 수신·암호화·파일 보호 경로를 사용합니다. AI 가이드는 대화에서 사용자가 허락한 대상과 범위만 처리하도록 요구하며, 앱이 대화상 허락을 독립적으로 검증하지는 않습니다. 수신 승인 준비 후에도 호출 세션·권한을 재검증합니다. CLI 토큰은 새 로컬 PTY에만 상속하며 로그·문서로 추출하지 않습니다. 요청 성공과 상대 프로그램의 작업 완료를 구분하고 `DELIVERY_UNKNOWN`을 자동 재전송하지 않습니다. SSH·SFTP·터널은 인증·지문 검증을 공유하고 파일 전송은 임시 파일·크기 확인·최종 이름 전환·실패 복구를 유지합니다.

새 로컬 PTY는 앱을 실행한 부모 Passport 세션의 제어·알림 인증, AI 실행 ID, 복원·시작 로더 환경변수를 제거한 뒤 자신의 인증과 설정을 적용합니다. 일반 사용자 환경변수와 `ZDOTDIR`은 보존하며, 부모의 `PASSPORT_RESUME` 값으로 새 세션의 복원 연동 여부를 판단하지 않습니다.

외부 링크는 main이 소유권·HTTP/HTTPS URL을 검사하고 실제 주소 확인 후 `openExternal` 직전에 다시 검사합니다. 외부 탐색·임의 창·권한 요청을 차단합니다. 쪽지 파일은 확장자·크기·해시·경로·OS 다운로드 보호가 모두 통과해야 공개하며 자동 열기·실행·사용자 요청 없는 AI 전달을 추가하지 않습니다.

### 세션 복원 계약

`settings.sessionResume`은 기본 false인 전역 설정입니다. `session_resume` 테이블은 문서 revision과 분리하며, 일반 백업·portable·템플릿에서 제외합니다. DB 7 이행 전에 백업하고 구버전 앱의 쓰기를 차단합니다. main은 연결 대상·소유 창·연결 세대·설정 세대를 검사하고, OFF와 패널 삭제 뒤 도착한 응답으로 기록을 되살리지 않습니다.

설정을 켤 때 기존 연결의 실제 로더·SSH 추적기 적용 여부를 확인합니다. 미적용 연결은 화면만 저장하며 패널에 다시 연결 안내와 확인 동작을 제공합니다. 실행 중인 프로그램에 셸 명령을 주입하거나 자동 종료하지 않습니다. 적용된 연결을 OFF→ON으로 전환하면 기존 인증 세대를 유지해 이후 AI 실행을 추적합니다. 미적용 상태의 저장 기록에는 사유를 남겨 재실행 뒤에도 화면만 복원된 이유를 표시합니다.

변경된 xterm 일반 화면을 5초 주기로 저장하며 종료 전에 최대 1초의 병렬 체크포인트를 요청합니다. 패널당 10,000줄·2MiB, 전체 64MiB를 제한하고 대체 화면·입력 모드를 저장하지 않습니다. 화면 복원은 renderer에만 전달하고 live PTY 입력·로그·알림 처리로 재생하지 않습니다. 창 이동은 기존 live snapshot 경로를 유지합니다.

helper의 인증된 실행 시작·종료·대화 시작 이벤트로 패널별 AI 실행 인수와 native ID를 묶습니다. 실행 인수는 암호화하고 최초 프롬프트·첨부·선택기 인수는 재전송하지 않습니다. 사용자 설정·훅·신뢰를 보존하며 알 수 없는 옵션이나 ID 미확인 시 자동 AI 재개만 생략합니다. 알림 허용과 복원 추적은 별개입니다. 종료 처리 전에 AI 실행 상태를 고정하며 사용자 AI 종료와 앱의 종료 처리를 구분합니다.

자동 탭 아이콘의 `SessionState.activeAgent`는 기존 인증된 `run-start`·`run-end`로 관리하는 메모리 상태입니다. 알림 허용·복원 저장과 독립이며 연결 세대와 실행 ID가 일치할 때만 갱신합니다. 내장 helper 폴더의 네이티브 `codex`·`claude` 실행기는 일반 로컬 셸에서도 실행 이벤트를 보냅니다. 실제 CLI 탐색에서 자신의 폴더와 `passport-agent-launchers.json`으로 식별되는 다른 Passport 실행기 폴더를 제외해 재귀 실행을 막고 인수·종료 코드를 전달합니다. 감지만으로 CLI 훅·알림·대화 복원을 켜거나 셸 로더·실행 정책을 변경하지 않습니다. 사용자 함수·별칭·앞선 PATH·절대 경로는 실행기를 우회할 수 있습니다. 단일 로컬 패널과 자동 아이콘 선택에만 적용하고, 직접 지정한 아이콘·문서·템플릿은 변경하지 않습니다. 응답 완료·대화 세션 종료는 CLI 실행 종료와 구분하며, 연결 종료·재연결 시 이전 실행 상태를 제거합니다.

`SessionStart`의 ID 발급과 대화 저장을 구분합니다. `startup`·`clear`만 확인된 빈 세션은 같은 옵션으로 새로 열며, 입력·완료·재개 이벤트가 확인되면 ID로 재개합니다. 같은 ID의 늦은 시작 이벤트로 입력 상태를 되돌리지 않습니다. Claude의 보고된 transcript 경로는 암호화한 복원 정보에 보관하고 재개 전에 파일 존재·크기를 확인합니다. 다른 세션 파일을 검색하거나 최근 ID로 대체하지 않습니다.

복원을 켠 로컬 대화형 Codex는 CLI 도움말에 `--no-daemon` 지원이 있을 때 이를 추가해 공유 서버의 다른 연결 환경이 훅 인증 정보를 대신하지 않게 합니다. 명시한 원격·비대화형 명령은 제외하며 원본 사용자 옵션을 저장합니다. 훅 명령은 같은 앱 경로에서 일정하게 유지하고 Codex 자체의 검토·신뢰 절차를 따릅니다. [Codex 훅 문서](https://learn.chatgpt.com/docs/hooks)와 [Claude 훅 문서](https://code.claude.com/docs/en/hooks)의 이벤트 의미가 바뀌면 실제 CLI 선택 검사도 함께 갱신합니다.

SSH는 기존 인증·호스트 키 확인 후 제한된 exec 채널로 Bash·zsh 임시 로더를 준비합니다. 연결별 nonce에 맞는 작업 폴더·준비 메타데이터만 소비하고, 미지원 환경에서는 일반 SSH 셸로 연결합니다. 시작 스니펫은 준비 신호 뒤 한 번 실행하고 자동 네트워크 재시도에서 재전송하지 않습니다. 실제 PTY를 사용하는 SSH2 루프백 fixture와 실제 OpenSSH 서버 검증은 구분합니다.

### 세션 로그 묶음 계약

DB 7의 `session_log_groups`·`session_log_segments`는 원본 `session_logs` 파일과 북마크 바이트 위치를 보존하며 구간 순서·시작 이유·종료 시각을 연결합니다. 기존 로그는 각각 독립 묶음으로 이행하고 이름·서버·AI 대화 ID만으로 합치지 않습니다. 복원 레코드의 `logGroup`은 대상 검증을 통과한 터미널에서만 재사용합니다. 새 터미널·접속 대상·SSH 지문 변경은 새 묶음으로 시작하며, 복원을 사용하지 않는 SSH 자동 재연결도 현재 연결의 묶음을 유지합니다.

기록 설정은 복원과 독립입니다. 새 접속·수동 기록 재개·용량 회전마다 새 원본 파일을 만들고, 기록을 끈 구간과 renderer 복원 화면을 로그에 채우지 않습니다. AI 도구가 재출력한 이전 대화는 live 출력이므로 기록합니다. 오래된 구간을 지우기 전에 최근 출력을 새 구간으로 넘기며, 묶음에는 만료·수동 삭제 개수를 남깁니다. 파일이 모두 만료되어도 복원 레코드나 현재 연결이 참조하는 묶음의 만료 정보는 유지합니다.

묶음 조회 커서는 구간 순번·파일 바이트 위치를 사용합니다. 앞 구간 삭제로 뒤 북마크 위치를 바꾸지 않고, 조회·검색은 제한된 페이지로 처리합니다. 전체 내보내기는 구간 경계와 원본 바이트를 합치며 개별 구간 내보내기는 원본 그대로입니다. 묶음 삭제·개별 구간 삭제와 기존 자동 기록 설정을 존중하며 삭제된 파일·묶음을 복원 데이터로 되살리지 않습니다.

### 터미널 쪽지 메뉴 계약

로컬·SSH 터미널 메뉴는 열 때 선택한 원문과 연결 세대를 고정합니다. 이후 출력이 바뀌어도 원문을 바꾸지 않으며, 패널 이동·숨김·연결 세대 변경 후에는 실행하지 않습니다. TUI 마우스 입력을 유지하고, 선택 영역이 있거나 Shift를 누른 우클릭·키보드 메뉴 요청에서 앱 메뉴를 엽니다. 붙여넣기는 기존 패널별 큐와 파일·이미지·텍스트 처리를 재사용합니다.

**바로 보내기**의 친구 선택은 정확한 기기 ID와 선택 원문으로 기존 `share.send`를 한 번 호출합니다. 작성 화면·기존 초안·첨부는 건드리지 않으며, 준비 중 중복 요청을 막습니다. 성공 알림은 전송 요청 접수만 뜻하고 상대 수신 승인·실제 전달 완료와 구분합니다. 오류는 표시하며 자동 재전송하지 않습니다. 친구 등록·수신 승인·본문 한도·암호화 등 기존 쪽지 검사는 그대로 적용합니다.

**쪽지로 작성**은 선택 원문만 작성 화면으로 가져오고 받는 사람은 직접 고릅니다. 기존 본문이나 첨부가 있으면 버리기·취소 확인을 거칩니다. 취소는 받는 사람·본문·첨부를 보존하고, 버리기는 기존 초안을 지운 뒤 새 원문을 채웁니다. 이 경로는 사용자가 전송 버튼을 누르기 전까지 `share.send`를 호출하지 않습니다. 선택 원문은 클립보드를 거치지 않습니다.

## 사용자 매뉴얼과 문서 관리

루트 `README.md`는 제목 **Passport 사용자 매뉴얼**의 전체 사용자 안내입니다. 링크 모음으로 축소하지 않습니다. 처음 설치한 사람이 실제 메뉴를 찾아 **진입 위치 → 입력·선택 → 저장·확인 → 결과**를 따라 할 수 있게 한국어 존댓말로 쓰고 실제 메뉴·버튼은 굵게 표시합니다. 메뉴 이름·저장 결과·제한을 구현과 대조하며 계획을 구현된 기능으로 적지 않습니다.

설치, 화면·메뉴, 로컬 셸·AI·프로파일·CLI, SSH·분할, 붙여넣기, 파일 전송, 쪽지, 템플릿, 알림·외형·단축키, 백업, 업데이트, 문제 해결을 유지합니다. 로컬 경로와 SSH 업로드, 이미지 경로와 AI 해석, 붙여넣기와 Enter 실행, 템플릿과 실행 프로세스, 수동 백업과 동기화를 구분합니다. 삭제·복원·충돌·인증 포함 범위는 해당 조작 옆에서 설명합니다. 플랫폼별 공개 버전이 다르면 실제 설치 파일이 있는 릴리즈로 연결합니다.

화면은 실제 앱의 격리 예제 데이터로 촬영하고 사용 설명 가까이에 alt·원본 링크와 함께 배치합니다. `npm run docs:screenshots`는 임시 프로필·루프백 fixture를 사용합니다. 실제 사용자 DB·서버·키·쪽지 내용은 쓰지 않습니다. 촬영 버전·조건을 매뉴얼과 해당 버전 AI 문서에 밝히고 개인정보·배치를 확인합니다. 화면 촬영도 창 표시가 필요하면 명시적인 허용 범위에서 수행합니다. 변경되지 않은 이미지는 재사용하되 과거 화면을 새 버전 촬영이라고 쓰지 않습니다.

문서는 다음 기준으로 관리합니다.

- 루트 README는 현재 사용자 매뉴얼, `docs/development.md`는 공통 개발 규칙, `docs/release.md`는 공통 릴리즈 절차입니다. `docs/README.md`는 문서 입구, 루트 `AGENTS.md`는 필수 규칙과 연결입니다. 공통 문서는 특정 버전의 AI 문서를 필수 규칙의 출처로 삼지 않습니다.
- 버전별 `docs/releases/v<버전>/`에는 `README.md`·`AGENTS.md` 두 개를 유지합니다. README는 해당 버전의 사용자 매뉴얼, AGENTS는 해당 버전의 검증 소스·환경·최종 결과·남은 제한·후속 확인 사항입니다. 공통 개발·E2E·문서·릴리즈 규칙을 복제하지 않습니다. 이전 버전 쌍도 보관합니다.
- 새 버전의 사용자 문서는 루트 매뉴얼을 기준으로 만들되 이미지·문서 상대 경로를 맞춥니다. AI 문서의 과거 검사 수·해시를 새 후보의 성공으로 복사하지 않습니다. 현재 문서 연결도 새 버전으로 갱신합니다.
- 작업 중 메모·계획·로그는 최종 결과를 반영한 뒤 삭제합니다. 완료 표시·archive 폴더로 보관하지 않습니다. 다음 작업에 필요한 공통 절차·구현 계약은 해당 가이드에, 버전별 최종 결과·미검증 제한은 해당 버전 AI 문서에 남깁니다.
- 패치 노트는 GitHub Release 본문에만 작성합니다. 로컬 릴리즈 MD·중복 검증 보고서·날짜별 일지를 만들지 않습니다. 공개 소스와 이후 문서 마무리 커밋은 구분합니다.
- `docs/assets/`는 사용하는 이미지만 유지합니다. 이전 버전에서 참조하는 이미지는 보존하고 바뀐 화면은 별도 이름을 사용합니다. `notes-compose.png`·`notes-pending.png`는 앱도 import합니다. 원본 소스·fixture·법적 고지는 문서 정리 대상이 아닙니다.

문서 변경 후 상대 링크·앵커·이미지·명령·현재 소스와의 일치, `git diff --check`를 확인합니다. 문구·링크·배치 수정만으로 전체 빌드·E2E·원격 Actions를 반복하지 않습니다. 확정된 문서는 저장소에 커밋·푸시하되 생성물·사용자 데이터·토큰은 넣지 않습니다.
