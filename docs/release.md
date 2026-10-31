# Passport 릴리즈 가이드

현재 소스에서 설치 파일을 검증하고 GitHub에 게시하는 절차입니다. 환경 준비는 [개발 가이드](development.md#환경-준비), 공개 버전의 소스·검증 결과·남은 제한은 [문서 안내](README.md)에서 해당 버전 AI 기록을 확인합니다. 이 가이드는 모든 버전에 공통으로 적용하며 버전 폴더에 복제하지 않습니다. 명령은 저장소 루트에서 실행하며 `<버전>`·`<실행-ID>`·`<검증-커밋>`은 실제 값으로 바꿉니다.

## 시작 전에 결정할 범위

1. 새 버전인지, 기존 공개 버전에 빠진 OS를 추가하는지 확인합니다. 새 버전은 현재 변경을 포함한 새 커밋을 사용하고, 기존 버전에 플랫폼을 추가할 때는 **그 공개 태그와 같은 커밋**을 사용합니다.
2. 대상은 `mac-arm64`·`win-x64`입니다. 두 OS는 같은 버전·같은 소스 커밋에서 각자의 네이티브 환경으로 검증합니다. 한 OS만 수행했다면 나머지는 검증 대기로 명시합니다.
3. 로컬 검증, 실제 창 표시·데스크톱 검사, GitHub 게시, 사용자 설치본 교체를 구분합니다. 사용자가 이미 요청한 범위는 다시 허락을 묻지 않고 수행합니다. 일반 릴리즈 요청만으로 창 표시를 허용받았다고 해석하지 않습니다.
4. 다른 작업 폴더·컴퓨터에서 같은 버전을 게시 중인지 확인합니다. 여러 플랫폼의 게시 담당자를 하나로 정하거나 순차 실행합니다. 로컬 잠금은 컴퓨터 간 중복 게시를 막지 못합니다.

**정식 검증에는 `--desktop`이 필수입니다.** 실제 데스크톱 검사를 명시적으로 허용받지 않았다면 숨김 preview와 준비 작업까지 수행하고 해당 조건만 확인합니다. preview를 정식 검증으로 고치거나 데스크톱 검사를 자동 허용하지 않습니다. 게시 요청을 받았고 정식 검증을 통과했다면 아래 계획 확인부터 게시 완료까지 진행합니다.

## 환경과 인증

- Node.js 24 이상·npm·Git·stable Rust와 각 OS의 네이티브 빌드 도구를 준비합니다. Mac은 Python 3·OpenSSL·Xcode Command Line Tools, Windows는 Python·OpenSSL·MSVC·SDK·Spectre 라이브러리·Windows PowerShell 5.1·PowerShell 7이 필요합니다. 자세한 위치와 명령은 [개발 환경](development.md#환경-준비)을 따릅니다.
- 검증은 `npm run release:verify`로 실행합니다. `npm ci`, Electron ABI 네이티브 의존성, Rust helper, FTP/FTPS용 Python 가상 환경을 새로 준비합니다. `FTP_TEST_PYTHON`을 지정했다면 해당 Python에 fixture 의존성이 설치되어 있어야 합니다. OpenSSL도 실행 가능해야 합니다.
- 게시 인증은 `GH_TOKEN`, `GITHUB_TOKEN`, 또는 `gh auth login`으로 준비합니다. 게시 도구는 환경 변수 또는 `gh auth token`의 캡처된 출력을 사용합니다. GitHub의 `poyal/passport`에 Release·자산을 쓸 수 있는 권한이 필요합니다. 토큰을 문서·명령 인수·로그에 출력하지 않습니다.
- 소스·태그 push에 필요한 Git 원격 인증도 준비합니다. Release API 인증과 Git push 인증은 별개입니다. 게시 스크립트는 push나 태그 생성을 대신하지 않습니다.
- 새 검증마다 도구 버전과 출처를 기록합니다. 현재 파이프라인은 Node 최소 버전과 Cargo 실행 여부를 확인하지만 모든 도구의 패치 버전을 고정하지는 않습니다. 다른 OS·ABI의 네이티브 산출물은 재사용하지 않습니다.
- Mac의 새 ad-hoc 후보는 실제 `safeStorage`를 처음 사용할 때 키체인 접근 승인을 요청할 수 있습니다. 숨김 GUI의 앱 데이터 격리는 OS 키체인 승인까지 대신하지 않습니다. 요청한 후보 앱을 확인한 사용자가 macOS 창에서 직접 승인하며, 암호를 채팅·명령·로그로 받거나 키체인 삭제·접근 제어 변경·평문 mock으로 우회하지 않습니다. `한 번 허용`은 재시작 때 다시 물을 수 있습니다. 승인 대기로 검사가 실패했다면 해당 실패를 유지하고 후보의 OS 암호화 접근을 확인한 뒤 전체 정식 검증을 새로 실행합니다.
- Mac 설치 파일 단계는 DMG 내부 후보의 실제 키체인 암호화·복호화를 격리 데이터로 먼저 확인합니다. OS 승인 준비에는 최대 180초를 허용하고 결과 로그를 증거에 포함합니다. 준비 실패는 릴리즈 실패이며 GUI 검사와 정상 종료의 기존 제한 시간은 늘리지 않습니다. 새로 패키징한 후보는 다시 승인이 필요할 수 있으므로 이 단계의 OS 창을 확인합니다.
- Mac SSH의 `Background` 세션은 로그인 사용자의 키체인 상호작용이 거부될 수 있습니다. `launchctl managername`과 `security show-keychain-info ~/Library/Keychains/login.keychain-db`로 확인하고, `User interaction is not allowed`이면 키체인 잠금·접근 제어·HOME을 바꾸지 않습니다. 실제 데스크톱 검사 허용 범위에서 같은 사용자의 `gui/<UID>` 로그인 세션에 일회성 LaunchAgent를 등록해 **전체 정식 검증**을 실행합니다. 임시 plist·실행 스크립트는 `build/toolchains/`에 두고 Node·Rust·Python 경로를 명시하며 로그를 작업 폴더에 저장합니다. `launchctl bootstrap gui/<UID> <plist>`로 시작한 작업의 종료 코드·manifest·DMG 분리를 확인한 뒤 `launchctl bootout gui/<UID>/<Label>`로 등록을 해제합니다. 임시 작업을 로그인 시 자동 실행되는 `~/Library/LaunchAgents`에 설치하거나 키체인 승인을 자동 클릭하지 않습니다.

현재 명령 설명은 산출물 생성 없이 확인할 수 있습니다.

```sh
npm run release:verify -- --help
npm run release:publish -- --help
```

## 1. 버전과 깨끗한 소스 준비

```sh
git status --short
git remote -v
git fetch origin --tags
```

새 버전이면 `package.json`과 `package-lock.json`을 함께 갱신합니다. 다음 명령은 파일만 갱신하고 커밋·태그를 만들지 않습니다.

```sh
npm version <버전> --no-git-tag-version
```

사용법이 달라지면 루트 README를 실제 구현에 맞춰 수정하고 `docs/releases/v<버전>/README.md`·`AGENTS.md`를 준비합니다. 새 버전의 검증 결과는 미실행에서 시작합니다. 필요한 개발·릴리즈 가이드와 문서 입구도 함께 갱신합니다. 패치 노트는 GitHub 본문에 작성하므로 로컬 릴리즈 MD는 만들지 않습니다.

변경을 검토·커밋하고 `git status --short`가 비어 있는지 확인합니다. 기존 작업을 임의로 초기화하지 말고 필요하면 별도 checkout/worktree를 사용합니다. 최종 후보의 버전, 전체 커밋 SHA와 대상 OS를 확인합니다.

```sh
git rev-parse HEAD
node -p "require('./package.json').version"
npm run release:check
```

`release:check`는 타입·단위·게시 정책을 확인하는 빠른 검사이며 정식 검증을 대신하지 않습니다. 정식 검증 시작부터 게시 완료까지 추적 파일·HEAD를 바꾸지 않습니다. 검증 후 새 문서 커밋을 만들면 소스 일치 검사를 통과하지 못하므로, 실제 검사 수·최종 해시·공개 결과는 게시 후 별도 문서 커밋에 확정합니다.

## 2. 후보 검증

개발 중 숨김 리허설은 다음 명령을 사용합니다. 변경 중인 소스도 검사할 수 있지만 결과는 게시 불가입니다.

```sh
npm run release:verify -- --preview
```

정식 후보는 실제 데스크톱 검사 허용을 받은 상태에서 각 OS에서 실행합니다.

```sh
npm run release:verify -- --desktop
```

일반 GUI는 숨김 모드로, 실제 포커스·클립보드는 별도 desktop 단계로 실행합니다. 파이프라인의 순서는 다음과 같습니다.

| 단계 | 확인 내용 |
| --- | --- |
| dependencies·ftp-fixtures | `npm ci`, FTP/FTPS Python fixture·OpenSSL 준비 |
| Windows 도구·runtime | PowerShell 등 필수 도구, 고정 해시 Portable Git 준비 |
| build·unit·release-tests | Rust helper·앱 빌드, 타입·단위·통합, 배포 정책 회귀 |
| source-gui·source-desktop | 소스 앱의 전체 정책 대상 GUI·정상 종료·데스크톱 검사 |
| package·installer | 같은 소스를 DMG/NSIS로 패키징하고 설치 파일 검사 |
| packaged-smoke | 설치 파일 내부 앱의 실제 PTY·helper·정상 종료 |
| packaged-gui·packaged-desktop | 최종 설치 파일 내부 앱의 같은 GUI·데스크톱 검사 |
| 최종 확인 | 소스 불변·설치 파일 해시·원본 보고서·수명 감사 확인 |

Mac은 DMG를 검증하고 읽기 전용으로 마운트해 내부 앱의 codesign 무결성과 실행을 확인합니다. Windows는 NSIS 현재 사용자 범위·`/allusers` 거절을 검사하고 설치 파일의 페이로드를 추출해 실행합니다. 기존 사용자 설치 앱을 교체하는 단계는 아닙니다.

출력은 다음 위치에 생깁니다.

```text
release/builds/<실행-ID>/                 설치 파일과 패키징 결과
release/checks/<실행-ID>/verification.json 검증 manifest
release/checks/<실행-ID>/                 로그·원본 GUI 보고서·수명 감사·fixture
```

실행 ID에는 시각·커밋·OS·아키텍처가 포함됩니다. `artifact.json`과 `verification.json`에서 출처·정확한 커밋·상태를 확인합니다. 같은 이름·버전만으로 동일한 빌드라고 판단하지 않습니다.

### 통과 조건과 검사 한계

게시할 manifest는 `status: verified`, `preview: false`, 깨끗한 소스여야 합니다. `preview-verified`·실패·부분 검사 결과는 게시할 수 없습니다. 필요한 단계가 각각 한 번씩 통과해야 하며 설치본·증거 파일 해시가 그대로여야 합니다.

GUI는 `tests/e2e/release-policy.json`의 안정적인 ID·파일·제목·모드·플랫폼·생략 조건을 실행 전 목록과 실행 후 개별 결과에 대조합니다. 필수 시험의 누락·생략·중단·예상 실패·재시도·flaky는 실패입니다. 집계 숫자나 manifest의 status만 고쳐 통과시킬 수 없습니다. 게시 도구도 원본 GUI 보고서 네 개를 다시 판정합니다.

다른 플랫폼 전용 시험과 미선택 Docker·장시간 부하·설치된 AI CLI 검사만 정책에 따라 생략합니다. `PASSPORT_DOCKER_MANIFEST`, `PASSPORT_UI_STRESS=1`, `PASSPORT_TEXT_BENCH=1`, `PASSPORT_NATIVE_AI=1`을 지정한 선택 검사는 통과가 필수입니다. Windows 내장 Bash·cmd·Windows PowerShell·PowerShell 7, DPAPI·드라이브 검사는 환경 미준비를 이유로 생략할 수 없습니다. 고정 검사 수를 복사하지 말고 실제 정책과 보고서를 확인합니다.

`PASSPORT_UI_STRESS=1`은 16패널 10분과 SFTP·외형 변경·재로드를 섞은 30분 검사를 모두 선택합니다. `PASSPORT_STRESS=1`은 단위 단계의 4 GiB·10,000개 파일 검사를 선택합니다. 소스와 설치 파일에서 같은 선택 항목을 유지하고, 고정 작업 시간만 runner 예산에 더합니다. 파일 해시·수신 바이트·렌더 지연·메모리 원본 결과도 보존합니다. Docker 서버는 [재사용 절차](development.md#ftpftps와-선택-검사)로 두 OS와 설치본까지 유지할 수 있으며 정리가 끝나기 전 다른 실행의 fixture를 제거하지 않습니다. 실제 LAN 시나리오 결과는 SSH 터널을 통한 Docker 결과와 별도로 기록합니다.

세션 복원을 릴리즈할 때 설치된 Codex·Claude CLI를 함께 검사하려면 검증 명령에 `PASSPORT_NATIVE_AI=1`을 지정합니다. 소스와 최종 설치본에서 같은 CLI 버전으로 수행하며 실제 CLI 버전·훅 신뢰·정상 재시작·동일 대화 재개 범위를 기록합니다. 모델 응답은 루프백 fixture이므로 실제 유료 서비스 검증이라고 표시하지 않습니다. Electron의 HOME·USERPROFILE은 변경하지 않으며 상세 격리는 [개발 가이드](development.md#ftpftps와-선택-검사)를 따릅니다.

E2E 수명은 실행별 launches·exits·auditedShutdowns가 같고 숨김 표시·네이티브 포커스가 0이어야 합니다. 앱 종료는 코드 0·시그널 없음·10초 제한을 유지하며 강제 종료를 정상 종료로 적지 않습니다. 자세한 작성·복구 계약은 [E2E 가이드](development.md#e2e-실행과-작성)를 따릅니다.

설치 파일 내부 앱의 자동 검사와 깨끗한 계정에서의 실제 설치·제거·업그레이드, 물리 IME, OS 알림, 실제 AI 서비스, LAN의 다른 PC, 최소 지원 OS 실기는 구분합니다. 필요한 수동 검사는 격리 계정·VM 등에서 수행하고 기기·소스·범위·미실행 항목을 최종 문서에 남깁니다. 사용자 설치본 교체는 요청된 범위에서만 수행하며 데이터 보존·복구 확인이 끝나기 전 백업을 삭제하지 않습니다.

현재 Mac 패키징은 ad-hoc 서명이며 Developer ID·Apple 공증을 포함하지 않습니다. codesign 무결성 성공은 공증·Gatekeeper 승인과 다릅니다. Developer ID 배포로 전환할 때는 `electron-builder.mac-signed.cjs`의 요구 설정·`CSC_NAME`과 공증을 준비하고 정식 검증의 패키징 단계에도 같은 설정을 적용해야 합니다. 별도로 만든 signed DMG를 기존 manifest에 끼워 넣지 않습니다.

## 3. 소스와 원격 태그 확정

정식 검증을 통과한 **동일 커밋**을 원격에 올리고 `v<package.json 버전>` 태그를 그 커밋에 연결합니다. 저장소의 workflow 설정도 확인해 태그 push가 의도하지 않은 과거 게시 경로를 실행하지 않는지 확인합니다. 현재 `desktop.yml`은 수동 검증용이며 공개 게시하지 않습니다.

```sh
# 후보가 main의 검증된 HEAD이고, 원격 main과 충돌하지 않는 경우
git push origin main
git tag v<버전> <검증-커밋>
git push origin refs/tags/v<버전>
git ls-remote origin refs/tags/v<버전> 'refs/tags/v<버전>^{}'
```

별도 후보 브랜치를 사용했다면 해당 브랜치로 소스를 push합니다. 태그가 이미 있으면 커밋을 확인해 일치하는 것을 재사용합니다. 게시 도구는 원격 태그가 검증 커밋과 일치하는지 확인하며 태그를 생성·이동하지 않습니다. **이미 공개한 태그를 옮기거나 같은 버전을 다른 빌드로 교체하지 않습니다.** 새 코드가 필요하면 새 버전을 만듭니다.

## 4. 게시 계획과 실제 게시

먼저 읽기 전용 계획으로 파일·해시·원격 태그·기존 플랫폼 자산을 확인합니다.

```sh
npm run release:publish -- --manifest release/checks/<실행-ID>/verification.json
```

사용자가 GitHub 게시를 요청한 범위에서 같은 manifest에 `--execute`를 추가합니다.

```sh
npm run release:publish -- --manifest release/checks/<실행-ID>/verification.json --execute
```

게시 도구는 설치 파일을 재빌드하지 않습니다. 새 릴리즈는 초안을 만들고 검증한 파일을 업로드한 뒤 다운로드·해시 확인, 원격 태그 재확인, 공개 전환, 공개 다운로드 확인을 수행합니다. 기존 릴리즈는 다른 플랫폼 자산을 확인·보존하고 `SHA256SUMS.txt`를 합칩니다. 같은 이름의 다른 바이트는 덮어쓰지 않습니다.

새 릴리즈 본문은 GitHub 자동 노트로 생성하며 사용법 변화·수정·알려진 제한은 GitHub Release 본문에서 정리합니다. 기존 본문은 게시 도구가 덮어쓰지 않습니다. 저장소에 별도 릴리즈 MD를 요구하거나 같은 패치 노트를 복제하지 않습니다. 직접 올리는 자산은 설치 파일과 `SHA256SUMS.txt`이며 GitHub의 자동 Source code 링크와 구분합니다.

### 두 OS 취합과 기존 릴리즈에 추가

각 OS에서 차례로 게시하거나, 같은 버전·커밋의 `release/builds/<실행-ID>/`와 `release/checks/<실행-ID>/`를 **상대 경로 그대로** 한 작업 폴더에 모아 다음과 같이 게시합니다. manifest뿐 아니라 참조된 설치 파일·로그·원본 GUI 보고서도 모두 있어야 합니다. 게시하는 checkout도 정확히 검증한 커밋의 깨끗한 상태여야 합니다.

```sh
npm run release:publish -- --manifest release/checks/<Mac-ID>/verification.json --manifest release/checks/<Windows-ID>/verification.json
# 계획 확인 후 같은 인수에 --execute 추가
```

같은 버전의 공개 작업을 동시에 수행하지 않습니다. 기존 릴리즈의 체크섬 교체 중 일시적으로 체크섬 파일이 없을 수 있습니다. GitHub 불변 릴리즈를 사용한다면 공개 후 파일 추가가 불가능하므로 두 OS를 초안 단계에서 함께 게시해야 합니다.

기존 버전에 플랫폼을 추가할 때는 그 공개 태그를 별도 checkout하여 **태그에 포함된 스크립트와 요구 파일**로 검증합니다. 이후 변경이 들어간 main을 빌드해서 기존 버전에 넣지 않습니다. 현재 공통 규칙을 개선했더라도 과거 태그의 코드가 자동으로 바뀌지는 않습니다. 코드 수정이 필요하면 새 버전으로 전환합니다. 대상 버전의 소스·누락 플랫폼은 버전 AI 기록과 실제 GitHub 공개 상태를 함께 확인합니다. 과거 1.1.1 전용 소스·자산 교체 예외를 새 버전에 적용하지 않습니다.

2026-10-20 사용자는 Windows 최소 창 크기의 로그 화면 결함을 안내받은 뒤 수정본도 **1.3.5로 게시**하도록 명시했습니다. 이 예외는 아직 공개하지 않은 Windows 1.3.5 설치본에만 적용합니다. Mac `v1.3.5` 태그·DMG는 고정하고 Windows 수정 소스는 `v1.3.5-win-x64`로 구분합니다. 게시 도구는 Mac 태그 커밋·자산 ID·크기·SHA-256과 Windows 검증 커밋·소스 태그를 대조하고, 변경 범위를 로그 레이아웃·화면 재로드 후 터미널 이력 보존·관련 검사·게시 도구·문서로 제한합니다. 정식 검증·다운로드 검증·동일 이름 자산의 덮어쓰기 금지는 그대로 유지하며 다른 버전에 적용하지 않습니다.

## 5. 실패 후 재개

| 상황 | 처리 |
| --- | --- |
| 의존성·도구·fixture 준비 실패 | 실제 오류와 로그를 확인해 환경을 고친 뒤 검증 재실행. 필수 검사를 생략하지 않음 |
| 소스·설치본 GUI·종료 실패 | 관련 검사로 원인 확인 → 소스 변경 커밋 → 전체 정식 검증 재실행. 실패 기록을 성공으로 수정하지 않음 |
| 검증 후 소스·설치 파일·증거 변경 | 기존 manifest 폐기 후 정식 검증. 검증한 파일을 재빌드본으로 바꾸지 않음 |
| 태그 없음·다른 커밋 | 검증 커밋·원격 상태 확인. 미생성 태그만 올바르게 준비하며 기존 공개 태그는 이동하지 않음 |
| 업로드·다운로드·통신 실패 | 같은 커밋·manifest·검증 파일을 보존한 채 동일 게시 명령 재실행. 동일 자산을 확인하고 누락분을 재개 |
| 공개 후 로컬 복사·최종 기록 실패 | 먼저 GitHub 실제 공개 상태·다운로드 해시를 조회. 새 파일을 만들지 않고 같은 manifest로 후속 단계 재개 |
| 같은 이름의 다른 파일·불변 릴리즈 | 자산 덮어쓰기·정책 우회 없이 출처 확인. 다른 빌드가 필요하면 새 버전 사용 |

검증 실패는 `verification.json`에 failed로 남고 다음 실행은 새 ID를 사용합니다. 게시 도중 실패한 초안과 설치 파일·증거는 **현재 작업을 재개하는 동안에만** 필요합니다. 작업을 끝내면 최종 결과·남은 문제를 문서·이슈에 남기고 실패 앱·중간 로그도 삭제합니다.

### 잠금과 마운트 정리

`release/checks/local-release.lock`은 같은 작업 폴더의 검증·게시 중복을 막습니다. PID·hostname·workingDirectory·생성 시각을 확인하고 해당 프로세스가 종료된 것을 확인한 뒤에만 남은 잠금 파일을 삭제합니다. 정상 실행은 finally에서 잠금을 제거합니다. 다른 checkout·컴퓨터의 잠금과는 별개이므로 게시 순서를 따로 관리합니다.

Mac 검증 후 DMG 분리가 실패하면 로그의 마운트 경로와 사용 중인 시험 앱을 확인합니다. 해당 시험이 종료된 뒤 그 볼륨만 `hdiutil detach <마운트-경로>`로 분리합니다. 다른 앱·볼륨을 강제로 종료하거나 분리하지 않습니다. 마운트가 남은 상태에서 관련 설치 파일·실행 폴더를 지우지 않습니다.

## 6. 공개 확인과 최종 문서

게시 출력의 `published-and-download-verified` 상태와 실제 GitHub Release에서 버전·태그·대상 파일·크기·SHA-256·합본 체크섬을 확인합니다. 다른 플랫폼의 기존 자산도 그대로인지 확인합니다. 로컬 manifest만으로 공개 완료를 선언하지 않습니다.

공개가 확인되면 해당 버전 AI 문서에 다음 최종 결과를 반영하고 별도 문서 커밋으로 저장소에 올립니다.

- 공개 버전·태그·정확한 배포 소스 커밋·대상 OS·검증 환경.
- 단위·정책·소스 및 설치본 GUI 결과, 정책상 생략 사유, 수명·표시/포커스 감사.
- 설치 파일 이름·크기·SHA-256, 서명·공증 상태, 공개 다운로드 확인.
- 별도 실기 범위와 미실행 항목, 미해결 문제의 이슈 연결.

루트 README의 실제 다운로드·사용법과 버전 사용자 문서도 맞춥니다. 배포 후 문서 커밋을 공개 바이너리의 소스라고 적거나 기존 태그를 이동하지 않습니다. 이전 버전 두 문서는 보관하며 중간 보고서·JSON·작업 일지는 추가하지 않습니다.

## 산출물 정리

`release/`는 **작업 중 임시 공간**입니다. 빌드는 `release/builds/`, 검증은 `release/checks/`, 게시 준비·복사본은 `release/packages/`, 설치 교체 중 복구본은 `release/backups/`를 사용합니다. 기존 도구의 release 루트 출력도 임시 생성물입니다. `release:publish --execute`의 `release/packages/v<버전>/local/<대상>/` 복사본도 영구 보관소가 아닙니다.

검증·게시·복구를 재개할 동안에는 필요한 파일을 유지합니다. 작업 종료 시 최종 결과를 문서에 반영하고, 게시 작업이라면 공개 다운로드까지 확인한 뒤 성공·실패 빌드·설치 파일·로그·스크린샷·trace·임시 프로필·작업용 복구본을 삭제합니다. 최신 하나·직전본·실패·KEEP 표시라는 이유만으로 남기거나 다른 폴더에 옮겨 보관하지 않습니다. 사용을 마친 `release/` 자체도 제거합니다.

함께 정리할 생성물은 [개발 가이드의 목록](development.md#폴더와-빌드-결과)을 따릅니다. 특히 `native/helper/target/`, `resources/terminal/helper/`·`runtime/`도 포함합니다. **`native/helper`의 Rust 소스·Cargo.lock, `resources/terminal/runtime-manifest.json`, `build/installer.nsh`, `assets` 원본·라이선스는 삭제하지 않습니다.** 폴더 이름만 보고 전체를 지우지 않습니다.

삭제 전에는 실행 중인 빌드·검사·앱, 마운트된 DMG, 다른 작업에서 사용하는 경로를 확인합니다. 사용자 설치 앱·실제 DB·앱 데이터 폴더의 자동 백업은 작업 생성물과 별개입니다. 설치 교체·복구가 진행 중이면 복구본은 완료 뒤 정리합니다.

사용자가 요청해 임시 Mac 앱을 열어 둔 동안에는 앱 묶음에 `alfred:ignore` 태그를 적용합니다. 검증한 앱을 안내할 때 `release/builds/Passport.app` 상대 심볼릭 링크를 사용하고 앱 복사본을 추가하지 않습니다. 앱 사용 종료 후 링크와 대상도 삭제합니다.

## 수동 원격 검증

[Desktop verification](../.github/workflows/desktop.yml)은 `workflow_dispatch`의 `all`·`mac-arm64`·`win-x64` 대상으로 같은 정식 검증을 실행하고 작업 산출물을 업로드합니다. GitHub Release를 게시하지 않습니다. 원격 실행을 요청받았을 때만 정확한 ref·대상으로 수행하고, 결과가 다른 소스인지 확인합니다. 문서 수정이나 일반 검증 요청만으로 Actions를 실행하지 않습니다.

워크플로를 교체할 때는 기본 브랜치 파일뿐 아니라 GitHub의 활성 상태·진행 및 대기 실행·태그 대상 YAML도 확인합니다. 과거 ref에서 실행할 수 있는 게시 경로를 그대로 둔 채 로컬 게시와 동시에 실행하지 않습니다. 원격 결과도 로컬·실기 범위와 구분해 최종 문서에 기록합니다.

2026-10-21 사용자는 기존 Windows 검증 실패를 안내받은 뒤 **1.3.0·1.3.4·1.3.6 Windows 게시**와 실제 데스크톱 검사를 요청했습니다. 미게시 Windows 1.3.0·1.3.4는 각각 원본 태그에서 필요한 수정만 반영하고 `v1.3.0-win-x64`·`v1.3.4-win-x64`로 소스를 구분합니다. 1.3.0은 격리 시험 프로필의 Downloads 준비·실제 기본 셸에 맞춘 시작 경로·연결 복구 검사, Claude 완료 이벤트의 실제 계약에 맞춘 시험 기대값과 Windows PowerShell 5.1의 다운로드 Zone.Identifier 기록 호환성·실제 보호 회귀 검사, 1.3.4는 최소 창 크기의 로그 레이아웃·화면 재로드 후 터미널 이력 보존·관련 회귀 검사와 AI 복원 시험의 실제 입력 준비 신호 동기화, 두 버전의 게시 출처 검사·문서만 변경할 수 있습니다. 기존 Mac 태그·자산 ID·크기·SHA-256을 고정하며 검증 생략이나 기존 설치 파일 덮어쓰기는 허용하지 않습니다. Windows 1.3.6은 원본 `v1.3.6` 소스를 사용합니다.
