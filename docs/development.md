# 개발 안내

[전체 문서](README.md) · [Windows·macOS 개발 규칙](platform-development.md) · [구현 구조](architecture.md) · [검증 결과](verification.md)

OS 관련 코드를 수정하기 전에 [플랫폼 개발 가이드](platform-development.md)를 읽는다. 분리 경계, import 규칙, 계약·수명, 변경별 검사와 Windows 인계 기준을 정의한다. 이 문서는 환경 준비와 실행 명령의 진입점이다.

## 환경 준비

Node.js 24 이상, npm, stable Rust 도구 체인(cargo)을 사용한다. 네이티브 모듈을 빌드하려면 macOS에서는 Xcode Command Line Tools, Windows에서는 Visual Studio C++ 빌드 도구와 Python이 필요하다. Mac은 Apple Silicon, Windows는 대상 아키텍처와 같은 x64 또는 ARM64 환경을 사용한다.

```sh
npm ci
npm run build:helper
# Windows에서만: npm run prepare:runtime -- x64 (ARM64는 arm64)
npm run dev
```

React 화면은 Vite로 갱신된다. 메인 프로세스나 preload를 수정한 뒤에는 개발 앱을 재시작한다.

빌드한 화면과 메인 프로세스를 함께 실행하려면 다음을 사용한다.

```sh
npm run build
npm start
```

`postinstall`에서 Electron용 네이티브 의존성을 준비한다. better-sqlite3와 node-pty는 Electron ABI에 맞아야 하므로 일반 Node.js용으로 임의 재빌드한 바이너리와 섞지 않는다.

Windows는 `npm ci`의 postinstall에서 ConPTY 동시 접근 수정 소스를 해시로 확인하고 node-pty를 강제 컴파일한다. Python·Visual Studio C++ 빌드 도구·Windows SDK·Spectre 완화 라이브러리를 준비한다. 현재 개발·패키징에서는 `npm ci --ignore-scripts`나 `npmRebuild=false`로 이 절차를 우회하지 않는다. 이전에 포함 바이너리만 점검한 기록은 현재 수정본 검증을 대신하지 않는다. 패치 해시가 달라지면 검사를 끄지 말고 의존성과 원본 변경을 검토한다.

```powershell
npm ci
npm run prepare:runtime -- x64
npm run build
npm run check
npm run dev
```

ARM64에서는 대상과 같은 Node·MSVC·Rust 도구와 `prepare:runtime -- arm64`를 사용한다. 빌드 구성의 존재와 실기 검증 완료는 구분한다. [플랫폼별 준비·문제 진단](platform-development.md#6-로컬-준비와-문제-진단)을 함께 확인한다.

`scripts/patch-ssh2.mjs`는 ssh2 1.17.0의 DH group1 구현에서 Electron/BoringSSL이 제공하지 않는 이름 기반 `modp2` 대신 RFC 2409 §6.2의 동일한 소수를 명시적으로 지정한다. 설치·빌드·단위 시험에서 멱등적으로 적용하며 의존성 버전이나 패치 대상이 달라지면 중단한다. Passport는 현대 기본 협상 목록 뒤에 SHA-1 group14·GEX·group1을 항상 추가한다. 호스트별 옵션은 없으며 이전 `legacySSH` 필드는 파싱 과정에서 제외한다. 전역 `crypto` API를 변경하지 않는다.

## 소스 구조

| 경로            | 역할                                                          |
| --------------- | ------------------------------------------------------------- |
| `src/main/`     | SSH·파일 연결, 로컬 셸, 전송 큐, 터널, 데이터·자격 증명, IPC  |
| `src/main/platform/` | Windows·Mac의 터미널, 파일 클립보드, 데스크톱, 알림 endpoint 구현 |
| `src/preload/`  | 허용된 호출과 이벤트를 전달하는 브리지                        |
| `src/renderer/` | 호스트·탭·분할·파일·설정 화면과 xterm.js                      |
| `src/shared/`   | 데이터 검증, IPC 타입, 분할 트리와 테마                       |
| `tests/`        | 단위·실제 프로토콜 통합·Electron GUI 시험과 로컬 서버 fixture |
| `scripts/`      | 개발 실행, 빌드·패키지 검증, Docker 시험, 문서 스크린샷 촬영  |
| `design/`       | 앱에서 사용하는 아이콘 원본과 승인 당시 디자인 시안           |
| `docs/`         | 사용·개발·설계·검증 문서와 문서용 이미지                      |

## 데이터와 별도 프로필

기본 데이터 폴더는 macOS `~/Library/Application Support/Passport`, Windows `%APPDATA%/Passport`다. SQLite 메타데이터, OS로 보호한 자격 증명, SSH 호스트 키, 선택한 세션 로그와 최근 7개 일별 백업을 저장한다.

`PASSPORT_DATA_DIR`로 테스트 전용 폴더를 지정할 수 있다. macOS 예시:

```sh
PASSPORT_DATA_DIR=/tmp/passport-development npm run dev
```

Windows PowerShell 예시:

```powershell
$env:PASSPORT_DATA_DIR = Join-Path $env:TEMP 'passport-development'
npm run dev
```

현재 SQLite 스키마는 5이며 문서·portable package는 버전 2다. DB 이행 전 `before-v5-<timestamp>.sqlite` 백업을 남긴다. 여러 탭을 묶은 이전 템플릿은 제외하고, 단일 탭 템플릿과 열린 작업 배치는 유지한다. v0.1·v0.3.0 데이터는 자동 승격하며, 승격된 DB를 구버전에서 다시 쓰는 것을 차단한다. 기존 버전을 비교할 때는 프로필 복사본을 사용한다. 기기 간 데이터 이동은 앱의 내보내기·가져오기 흐름으로 검증한다.

## 기본 검사

```sh
npm run check
npm run test:e2e
```

`check`는 타입과 단위·통합 검사를, `test:e2e`는 빌드 후 창을 숨긴 Electron GUI 검사를 실행한다. 기본 모드는 네이티브 창 표시·포커스를 차단하며 DOM 입력·스크린샷·실제 PTY는 검사한다. 실제 OS 포커스와 클립보드를 쓰는 `@desktop` 검사는 기본 실행에서 제외한다.

로컬 작업에서는 이 숨김 모드를 유지한다. 일반적인 개발·검증 요청을 이유로 `--show`나 `--desktop`을 자동 실행하지 않는다. 창 표시·실제 데스크톱 검사는 사용자가 명시적으로 요청한 경우에만 실행하며, 필요한 실기 확인을 수행하지 않았으면 결과에 대기로 남긴다. 아래 표시 모드 명령은 그런 별도 실행을 위한 명령이다.

```sh
npm run test:e2e                           # 숨김, 포커스 없음
npm run test:e2e:show                      # 창만 표시, 포커스 없음
npm run test:e2e:desktop                   # OS 포커스·클립보드 검사만, 다른 작업과 분리
npm run test:e2e -- tests/e2e/shutdown.spec.ts
```

결과는 `release/checks/<실행 ID>/`의 로그·JSON·스크린샷에 남는다. 이미 빌드했다면 `node scripts/e2e.mjs <파일>`로 재빌드 없이 필요한 검사만 실행한다. `npx playwright test`도 기본 숨김 모드를 사용한다. 예전 빌드나 설치본이 숨김 모드를 지원하지 않으면 창을 열기 전에 거부하므로 먼저 새 소스로 빌드한다. 정상 사용 앱의 창 동작은 그대로이며 테스트는 별도 데이터 폴더를 사용한다.

초기화 범위가 명확한 UI 검사는 파일·describe마다 앱과 기본 창을 재사용한다. 사례 사이에는 문서·세션·로그·모의 API를 복구하고 같은 창의 renderer만 다시 읽는다. 실제 종료·재시작·시작 환경 검사는 독립 실행을 유지한다. `artifact.json`의 `lifecycle`과 `lifecycle.jsonl`에 실제 앱 시작·창 생성·종료·표시·포커스 수를 기록한다. 새 사례의 작성 기준과 제한은 [E2E 실행과 앱 재사용](e2e.md)을 따른다.

네이티브 모듈이 포함된 시험은 `scripts/test.mjs`가 실행 환경을 맞추므로 직접 일반 Node.js에서 Vitest를 실행하지 않는다. 숨김 모드도 Electron 실행을 위한 데스크톱 세션은 필요하다. 시험은 localhost 서버 사용 가능 여부를 먼저 확인한다. 로컬 네트워크나 macOS 앱 등록을 제한하는 실행 샌드박스에서는 실행 권한을 허용한 뒤 검사해야 한다.

종료 회귀 시험만 반복하려면:

```sh
npx playwright test tests/e2e/shutdown.spec.ts --repeat-each=3
```

GUI 종료 검사는 Electron 종료 코드 0과 시그널 없음을 확인해야 하며 창이 닫힌 것만으로 성공으로 보지 않는다.

알림·새 창·폰트 회귀는 `tests/terminal-experience.test.ts`와 `tests/e2e/terminal-experience.spec.ts`에 있다. 숨김 시험은 실제 IPC·DB·PTY 경로와 창 표시/포커스 0회를 검사한다. 읽음 통합 시나리오에서는 네이티브 창 상태 조회만 대체하므로 실제 OS 포커스·알림 센터 검증을 대신하지 않는다. 실제 전경 읽음 시나리오는 `@desktop`으로 분리한다. 필수 GUI 목록과 플랫폼별 생략 기준은 `tests/e2e/release-policy.json`을 따른다. GUI 제목·파일·모드를 변경하면 같은 변경에서 정책도 갱신하고 `test:release`를 실행한다.

터미널 웹 링크 회귀는 `tests/terminal-links.test.ts`와 `tests/e2e/terminal-links.spec.ts`에서 확인한다. GUI 검사는 실제 OSC 8 링크를 클릭해 취소·확인·브라우저 실행 실패와 창 소유권 검사를 거치며, 네이티브 확인창과 `shell.openExternal`만 대체해 사용자 브라우저를 열지 않는다. 기본 브라우저의 실제 표시와 Windows 실기는 별도로 확인한다.

파일·이미지 붙여넣기는 `clipboard.terminal({ id })` IPC에서 처리한다. 메인 프로세스가 소유권·연결 세대를 검사하고 Electron 44의 `clipboard.read()` 결과를 파일·이미지·텍스트로 구분한다. macOS 파일 URL/파일 목록 plist, Windows Unicode CF_HDROP/탐색기 파일 목록과 표준 파일 URL 목록을 처리한다. Windows FileNameW만 노출되면 고정 PowerShell 코드로 전체 목록을 읽고 첫 경로가 원래 스냅샷과 같은지 확인한다. 이 보조 프로세스는 창을 숨기고 3초 제한을 적용한다. 이미지 파일은 사용자 데이터에 보관하며 renderer에는 경로만 전달한다.

`tests/paste.test.ts`는 파일 형식·셸 인용·저장 실패·비동기 순서/취소를 검사한다. `tests/e2e/paste.spec.ts`는 Electron 클립보드 읽기와 최종 입력 수신만 대체하고 실제 앱 키 처리·IPC·이미지 저장을 확인한다. 사용자 OS 클립보드는 수정하지 않는다. `windows-shells.spec.ts`는 각 실제 Windows 셸에서 붙인 경로로 파일을 읽는 검증도 포함한다. Finder/탐색기에서 직접 복사한 데이터와 실제 Claude/Codex의 이미지 해석은 별도 수동 확인 대상이며 [Windows 인계 문서](windows-paste-release.md)에 절차가 있다.

Mac은 Electron이 Finder 파일 이름만 노출하는 경우를 처리하기 위해 AppKit의 `NSPasteboard` 파일 URL 읽기를 추가로 사용한다. 고정된 JXA 코드를 비동기 `osascript`로 실행하며 셸에 파일 경로를 삽입해 실행하지 않는다. 3초 제한과 clipboard generation 검사를 적용한다. Mac 회귀 검사는 고유 이름의 별도 pasteboard에 실제 NSURL 목록을 쓰고 읽으며 일반 사용자 클립보드는 변경하지 않는다. 숨김 E2E도 이 별도 pasteboard로 네이티브 읽기만 연결하고 Electron에는 이름 텍스트만 주입해 원래 실패를 재현한다. macOS가 반환한 분해형 한글 경로는 유지하고 실제 파일 접근 가능 여부를 검사한다.

공개 폰트는 고정 버전의 Fontsource 의존성과 원본 D2Coding TTF를 포함한다. D2Coding 출처·파일 해시는 `src/renderer/fonts/sources.json`, 라이선스는 `licenses/fonts/`에 둔다. `scripts/notices.mjs`가 폰트 라이선스도 최종 앱에 복사한다. OS 소유 폰트는 설치된 것을 조회하며 파일을 배포하지 않는다.

## FTP·FTPS 통합 시험

Python 가상 환경에 fixture 의존성을 설치한다. FTPS fixture의 인증서 생성에는 OpenSSL도 필요하다. `FTP_TEST_PYTHON`을 지정하지 않으면 해당 시험은 건너뛴다.

```sh
python3 -m venv /tmp/passport-test-venv
/tmp/passport-test-venv/bin/pip install -r tests/fixtures/requirements.txt
FTP_TEST_PYTHON=/tmp/passport-test-venv/bin/python npm run check
```

위 명령은 macOS 기준이다. Windows에서는 가상 환경의 `Scripts/python.exe` 경로를 `FTP_TEST_PYTHON` 환경 변수로 지정한다.

## Docker OpenSSH 매트릭스

```sh
npm run test:ssh:docker
```

실행 중인 로컬 Docker 엔진, 이미지 저장 공간, 인터넷 연결이 필요하다. Docker 엔진의 아키텍처에 따라 `linux/amd64` 또는 `linux/arm64`의 Alpine·Ubuntu·Debian·Rocky·CentOS 서버를 실행한다. SSH 포트는 `127.0.0.1`의 임시 포트에 바인딩하고 실행 시 생성한 비밀번호와 키를 사용한다. 해당 실행의 컨테이너만 정리하며 기존 컨테이너·볼륨을 제거하지 않는다. 구형 CentOS 7은 아키텍처별 보관 저장소를 사용하고 역방향 DNS 조회를 꺼 로컬 fixture의 조회 지연을 피한다. Windows 체크아웃의 CRLF도 서버 시작 스크립트에서 정리한다.

검증 범위와 배포판별 결과는 [최신 검증 기록](verification.md)을 따른다. 결과 파일은 `docs/benchmarks/docker-ssh.json`이다. CentOS 7 시험 서버 두 개를 추가로 group1·SHA-1 GEX 전용으로 실행해 별도 설정 없이 구형 서버의 비밀번호·키·PTY·SFTP·터널 연결을 확인한다. 이 구성은 실제 CentOS 5/6 운영체제 시험과 구분한다.

같은 실행에서 실제 Electron 앱의 SSH 터미널과 SFTP 복사 메뉴도 검사한다. 8개 서버 구성 간 왕복 전송, 한글·공백 경로, 재귀 폴더·빈 파일, 충돌 처리, 원격 권한·이름 변경·삭제와 128MiB 왕복·취소 후 정리를 포함한다. `PASSPORT_E2E_EXECUTABLE`이 없으면 소스를 빌드해 실행한다. Windows 패키지를 대상으로 기록을 분리하려면:

```powershell
$env:PASSPORT_E2E_EXECUTABLE = (Resolve-Path 'release/win-unpacked/Passport.exe').Path
$env:PASSPORT_DOCKER_RESULTS = 'docs/benchmarks/docker-ssh-windows-v1.0.2.json'
$env:PASSPORT_DOCKER_GUI_RESULTS = 'docs/benchmarks/docker-desktop-windows-v1.0.2.json'
$env:PASSPORT_DOCKER_OUTPUT = 'release/checks/windows-docker/gui'
npm run test:ssh:docker
```

`PASSPORT_DOCKER_RESULTS`에는 단계별 진행과 프로토콜 검사 결과를, `PASSPORT_DOCKER_GUI_RESULTS`에는 데스크톱 전송 결과를 기록한다. GUI 결과 경로를 생략하면 시험 출력 폴더에 저장한다.

## 대용량·지속 출력 시험

```sh
PASSPORT_STRESS=1 node scripts/test.mjs tests/stress.test.ts
PASSPORT_UI_STRESS=1 npx playwright test tests/e2e/stress.spec.ts
npm run test:terminal:large
```

`test:terminal:large`는 한 터미널에 16·64·256·1024MiB를 단계별로 보내고 별도로 64KiB 긴 행 8MiB를 처리한다. UTF-8 한글·ANSI 색상·IP/URL·로그 강조, 자동 기록(보관 한도 64MiB)을 켠 상태에서 끝 표식의 실제 화면 표시, 입력 왕복 P95, 프레임 지연, 전체 앱 작업 집합을 측정한다. 데이터는 64KiB 버퍼를 재사용하고 SSH backpressure를 따른다. 누적 출력량이며 xterm 스크롤백은 최근 10,000행이다. 1GiB 원문 전체를 메모리에 보관한다는 뜻이 아니다. 결과는 시험 출력 폴더의 `terminal-large-text.json`에 남긴다.

파일 시험은 4GiB 파일과 작은 파일 10,000개를 만들어 복사하므로 충분한 임시 저장 공간이 필요하다. UI 시험은 500개 호스트·16개 터미널에 10분간 출력을 보낸다. 평소 검사에서 생략되는 선택 시험이므로 실행 여부를 결과에 구분해 적는다. 로컬 시험 수치를 WAN 전송 속도나 실제 키 입력부터 화면까지의 지연으로 해석하지 않는다.

Windows PowerShell에서 선택 부하 검사를 실행하려면:

```powershell
$env:PASSPORT_STRESS = '1'
$env:PASSPORT_STRESS_RESULTS = 'docs/benchmarks/file-stress-windows-v1.0.2.json'
node scripts/test.mjs tests/stress.test.ts
$env:PASSPORT_DISABLE_UPDATE_CHECK = '1'
$env:PASSPORT_E2E_EXECUTABLE = (Resolve-Path 'release/win-unpacked/Passport.exe').Path
$env:PASSPORT_UI_STRESS = '1'
$env:PASSPORT_TEXT_BENCH = '1'
npx playwright test tests/e2e/stress.spec.ts tests/e2e/throughput.spec.ts --output=release/checks/windows-terminal-load
```

파일 부하 검사는 4GiB 해시와 작은 파일 10,000개 전체 내용을 확인한다. `PASSPORT_STRESS_RESULTS`를 지정하면 RSS 증가와 소요시간을 별도 JSON으로 보관한다. 터미널 부하 결과도 지정한 시험 출력 폴더에 저장한다.

## 문서와 설치본

문서를 바꿀 때는 이동한 문서의 링크·이미지 경로와 현재 배포 상태를 함께 확인한다. README에는 설치·사용 안내를 두고 개발 명령과 미완료 검증 항목의 상세 기록은 이 폴더에 둔다.

- README 화면 갱신: [스크린샷 안내](screenshots.md).
- DMG·EXE 생성과 실제 설치본 확인: [배포 안내](distribution.md).
- 제품 범위와 제외 기능: [확정 계획](plan.md).

## 로컬 셸 리소스

`npm run build`는 Rust helper를 현재 대상에 맞게 빌드하고 라이선스를 모은다. `PASSPORT_CARGO`로 cargo 실행 파일을 지정할 수 있다. 대상은 darwin-arm64, win32-x64, win32-arm64이며 Windows 설치본은 같은 대상의 Windows 빌드 환경을 사용한다. `npm run prepare:runtime -- x64` 또는 `-- arm64`는 고정된 공식 Portable Git을 내려받고 SHA-256을 확인해 시작 파일 패치를 적용한다. 생성된 바이너리·런타임은 Git에 넣지 않는다. `npm run dist:win`과 `dist:win:arm64`는 준비 단계를 포함한다.

프로파일과 알림 구조·수동 검증 한계는 [로컬 AI 작업 안내](local-ai-workspaces.md)를 따른다.

## 로컬 배포 검증

개발 중 빠른 검사는 `npm run release:check`, 숨김 모드 배포 리허설은 `npm run release:verify -- --preview`를 사용한다. OS 포커스 검사까지 포함하려면 작업을 방해하지 않는 데스크톱에서 `--desktop`을 추가한다. 정식 후보는 모든 변경을 커밋한 뒤 `npm run release:verify -- --desktop`으로 검사한다. OS 포커스 검사를 생략한 결과는 게시할 수 없다. 게시 단계는 검사한 설치 파일과 기록만 사용하며 재빌드하지 않는다. [운영 안내](local-release-guide.md)와 [배포 명령](distribution.md#로컬-검증과-게시)을 따른다.
