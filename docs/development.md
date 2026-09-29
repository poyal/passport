# 개발 안내

[전체 문서](README.md) · [구현 구조](architecture.md) · [검증 결과](verification.md)

## 환경 준비

Node.js 24 이상과 npm을 사용한다. 네이티브 모듈을 빌드하려면 macOS에서는 Xcode Command Line Tools, Windows에서는 Visual Studio C++ 빌드 도구와 Python이 필요하다. Mac은 Apple Silicon, Windows는 대상 아키텍처와 같은 x64 또는 ARM64 환경을 사용한다.

```sh
npm ci
npm run dev
```

React 화면은 Vite로 갱신된다. 메인 프로세스나 preload를 수정한 뒤에는 개발 앱을 재시작한다.

빌드한 화면과 메인 프로세스를 함께 실행하려면 다음을 사용한다.

```sh
npm run build
npm start
```

`postinstall`에서 Electron용 네이티브 의존성을 준비한다. better-sqlite3와 node-pty는 Electron ABI에 맞아야 하므로 일반 Node.js용으로 임의 재빌드한 바이너리와 섞지 않는다.

## 소스 구조

| 경로            | 역할                                                          |
| --------------- | ------------------------------------------------------------- |
| `src/main/`     | SSH·파일 연결, 로컬 셸, 전송 큐, 터널, 데이터·자격 증명, IPC  |
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

현재 SQLite 스키마는 2다. v0.1 데이터는 자동 승격하며, 승격된 DB를 v0.1에서 다시 쓰는 것을 차단한다. 기존 버전을 비교할 때는 프로필 복사본을 사용한다. 기기 간 데이터 이동은 앱의 내보내기·가져오기 흐름으로 검증한다.

## 기본 검사

```sh
npm run check
npm run test:e2e
```

`check`는 타입과 단위·통합 검사를, `test:e2e`는 빌드 후 Electron GUI 검사를 실행한다. 네이티브 모듈이 포함된 시험은 `scripts/test.mjs`가 실행 환경을 맞추므로 직접 일반 Node.js에서 Vitest를 실행하지 않는다. GUI 시험에는 데스크톱 세션이 필요하다.

종료 회귀 시험만 반복하려면:

```sh
npx playwright test tests/e2e/shutdown.spec.ts --repeat-each=3
```

GUI 종료 검사는 Electron 종료 코드 0과 시그널 없음을 확인해야 하며 창이 닫힌 것만으로 성공으로 보지 않는다.

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

실행 중인 로컬 Docker 엔진, 이미지 저장 공간, 인터넷 연결이 필요하다. macOS ARM64를 기준으로 `linux/arm64`의 Alpine·Ubuntu·Debian·Rocky·CentOS 서버를 실행한다. SSH 포트는 `127.0.0.1`의 임시 포트에 바인딩하고 실행 시 생성한 비밀번호와 키를 사용한다. 해당 실행의 컨테이너만 정리하며 기존 컨테이너·볼륨을 제거하지 않는다.

검증 범위와 배포판별 결과는 [최신 검증 기록](verification.md)을 따른다. 결과 파일은 `docs/benchmarks/docker-ssh.json`이다.

## 대용량·지속 출력 시험

```sh
PASSPORT_STRESS=1 node scripts/test.mjs tests/stress.test.ts
PASSPORT_UI_STRESS=1 npx playwright test tests/e2e/stress.spec.ts
```

파일 시험은 4GiB 파일과 작은 파일 10,000개를 만들어 복사하므로 충분한 임시 저장 공간이 필요하다. UI 시험은 500개 호스트·16개 터미널에 10분간 출력을 보낸다. 평소 검사에서 생략되는 선택 시험이므로 실행 여부를 결과에 구분해 적는다. 로컬 시험 수치를 WAN 전송 속도나 실제 키 입력부터 화면까지의 지연으로 해석하지 않는다.

## 문서와 설치본

문서를 바꿀 때는 이동한 문서의 링크·이미지 경로와 현재 배포 상태를 함께 확인한다. README에는 설치·사용 안내를 두고 개발 명령과 미완료 검증 항목의 상세 기록은 이 폴더에 둔다.

- README 화면 갱신: [스크린샷 안내](screenshots.md).
- DMG·EXE 생성과 실제 설치본 확인: [배포 안내](distribution.md).
- 제품 범위와 제외 기능: [확정 계획](plan.md).
