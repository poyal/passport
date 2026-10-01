# 패키징과 배포 안내

[전체 문서](README.md) · [개발 환경](development.md) · [검증 결과](verification.md)

이 문서는 설치본을 만드는 개발자용 안내다. 최종 사용자의 설치 방법은 [제품 README](../README.md#설치)에 둔다.

## 현재 상태

공개 버전과 준비 중인 버전은 [릴리즈 목록](releases/README.md)에서 확인한다. 1.1.0은 Apple Silicon Mac용 DMG와 Windows x64 EXE를 공개했다. `SHA256SUMS.txt`에는 두 설치 파일의 체크섬을 포함한다. Windows 1.1.0의 셸·PTY·DPAPI·GUI·설치·제거와 공개 파일 검증을 별도로 수행했다. Windows ARM64의 실제 설치·실행은 아직 확인하지 않았다. 공개 파일 해시와 버전별 시험 범위는 [검증 기록](verification.md)을 따른다.

Mac 설치본은 ad-hoc 서명이며 Developer ID 서명·Apple 공증을 포함하지 않는다. `codesign` 무결성 검사 통과는 Apple 공증이나 Gatekeeper의 실행 허용을 뜻하지 않는다. 현재 결과와 DMG 해시는 [검증 기록](verification.md)에 보관한다.

## 대상별 빌드

각 대상 OS와 아키텍처의 네이티브 환경에서 `npm ci`와 기본 검사를 먼저 수행한다.

| 대상                | 명령                     | 결과 파일                                  |
| ------------------- | ------------------------ | ------------------------------------------ |
| macOS Apple Silicon | `npm run dist:mac`       | `release/Passport-<version>-mac-arm64.dmg` |
| Windows x64         | `npm run dist:win`       | `release/Passport-<version>-win-x64.exe`   |
| Windows ARM64       | `npm run dist:win:arm64` | `release/Passport-<version>-win-arm64.exe` |

파일 이름의 버전은 `package.json`을 따른다. `npm run pack`은 설치 프로그램 없이 현재 환경의 앱 폴더를 만든다. `release/`와 `dist/`는 생성물이며 저장소에 커밋하지 않는다. README는 최신 공개 릴리즈 링크를 기본으로 사용하되 플랫폼별 공개 버전이 다르면 해당 버전 링크와 상태를 표시한다.

산출물의 저장 위치와 보관 기간은 [산출물 보관 규칙](#산출물-보관-규칙)을 따른다. 기존 명령의 루트 출력 경로는 아래에 명시한 전환 전 예외다.

Mac 최소 버전 목표는 14이며 macOS 27 로컬 환경과 macOS 15 GitHub Actions에서 앱 실행을 확인했다. Windows 대상은 Windows 11 x64·ARM64이며 각각의 설치 및 실행 검증을 구분한다. Intel Mac과 Rosetta 의존 Mac 패키지는 만들지 않는다.

Windows의 `npm ci`는 네이티브 재컴파일 후 [ConPTY 배치 스크립트](../scripts/prepare-node-pty.mjs)로 DLL·OpenConsole을 실제 네이티브 모듈 옆에 복사한다. 패키징의 [afterPack](../scripts/after-pack.mjs)에서도 다시 배치한다. electron-builder 재컴파일이 node-pty의 원래 postinstall 복사 결과를 지워도 패키지에 필요한 파일을 포함하도록 한다.

같은 스크립트는 node-pty 1.1.0의 Windows 종료 경로도 보완한다. 마지막 출력 뒤 조용한 PTY를 닫으면 추가 데이터 이벤트가 없어 출력 worker 정리를 시작하지 않던 경우에 정리를 예약한다. 출력 배출 대기는 유지하며 소스 의존성과 실제 패키지 양쪽에 적용한다. 의존성 버전이나 해당 코드가 바뀌면 패치를 자동 추정하지 않고 빌드를 중단해 검토한다.

Windows NSIS 설치본은 [설치 스크립트](../build/installer.nsh)에서 현재 사용자 전용으로 고정한다. 사용자 범위 선택 화면을 생략하고 설치 폴더 선택은 유지한다. 관리자 권한 상승과 `/allusers` 재정의를 허용하지 않는다. 생성된 설치본의 첫 화면과 명령줄 재정의를 검사하려면 다음을 실행한다. 검사 결과 JSON은 설치본과 같은 폴더에 저장된다.

```powershell
$passportVersion = (Get-Content package.json | ConvertFrom-Json).version
./scripts/windows-installer-smoke.ps1 -InstallerPath "release/Passport-$passportVersion-win-x64.exe"
```

## macOS 권한 유지와 Developer ID 서명

로컬 터미널의 Claude 같은 자식 프로세스가 보호된 파일이나 미디어 보관함에 접근하면 macOS는 Passport에 권한을 요청할 수 있다. Apple Music, OneDrive 등은 각각 별도의 권한이므로 처음에는 개별 확인이 필요하다. 앱 설정만으로 이 확인을 대신할 수 없다.

ad-hoc 서명은 앱을 다시 빌드해 교체할 때 코드 해시가 바뀐다. macOS가 저장한 앱의 코드 요구사항과 새 설치본이 일치하지 않으면 이전에 결정한 접근 권한을 다시 물을 수 있다. 업데이트 후에도 앱의 신원을 유지하려면 동일한 개발자 팀의 Developer ID Application 서명과 번들 ID `io.passport.desktop`을 유지해야 한다. [Apple 코드 서명 요구사항 설명](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

인증서를 키체인에 준비한 뒤 정식 서명용 명령을 사용한다. 개인 키나 인증서 암호를 저장소에 넣지 않는다.

```sh
security find-identity -v -p codesigning
CSC_NAME='Developer ID Application: Your Name (ABCDEFGHIJ)' npm run dist:mac:signed
```

`CSC_NAME`에는 위 명령에 표시된 인증서의 전체 이름을 넣는다. [서명 빌드 설정](../electron-builder.mac-signed.cjs)은 기존 패키지 리소스와 번들 ID를 유지하고 `forceCodeSigning: true`로 인증서가 없거나 사용할 수 없으면 빌드를 실패시킨다. 임시 서명으로 자동 전환하지 않는다. CI에서 키체인을 새로 준비해야 하면 electron-builder의 `CSC_LINK`·`CSC_KEY_PASSWORD`를 비밀 환경 변수로 공급할 수 있다. 이 경우에도 같은 `CSC_NAME`을 사용한다.

Developer ID 서명과 Apple 공증은 별도다. 이 명령만으로 공증 완료를 보장하지 않는다. 공증에 필요한 인증 정보는 electron-builder가 지원하는 `APPLE_KEYCHAIN_PROFILE` 등으로 따로 준비한다. 인증서 발급 전에는 기존 `dist:mac`·`pack` 및 CI 명령이 여전히 ad-hoc 설치본을 만든다. 공개 릴리즈를 정식 서명으로 전환할 때에는 릴리즈 워크플로의 패키징 단계에도 `--config electron-builder.mac-signed.cjs`와 인증서 환경 변수를 적용해야 한다.

처음 ad-hoc 설치본에서 Developer ID 설치본으로 전환할 때에는 권한 확인이 다시 필요할 수 있다. 이후 두 버전을 번갈아 `/Applications/Passport.app`에 덮어쓰지 않는다. 권한 취소나 새 접근 대상에 대한 확인까지 없애는 것은 아니다. 검증은 같은 설치본의 터미널 재연결·앱 재실행, 이후 동일한 개발자 서명을 사용한 두 빌드 사이의 업데이트를 각각 구분해 수행한다. 인증서가 없는 환경에서는 업데이트 간 권한 유지 검증을 완료한 것으로 기록하지 않는다.

## 아이콘과 오픈소스 고지

[확정한 v2 아이콘](icons.md)을 `scripts/build.mjs`가 `build/icon.png`로 복사한다. electron-builder가 해당 원본을 패키지 아이콘으로 사용한다. 원본 경로는 `design/icons/04-passport-terminal-v2.png`다.

루트의 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)는 설치본 포함 파일이므로 유지한다. `scripts/notices.mjs`는 의존성별 원본 라이선스와 테마 라이선스를 `dist/licenses/`에 준비한다. 문서 정리 시 이 패키징 경로를 누락하지 않는다.

## 패키지 실행 확인

설치본을 만들고 압축이 풀린 실제 실행 파일로 검사한다.

```sh
# macOS
node scripts/packaged-smoke.mjs release/mac-arm64/Passport.app/Contents/MacOS/Passport
```

```powershell
# Windows x64
node scripts/packaged-smoke.mjs release/win-unpacked/Passport.exe

# Windows ARM64
node scripts/packaged-smoke.mjs release/win-arm64-unpacked/Passport.exe
```

검사는 별도 임시 프로필에서 초기 화면, 렌더러 Node 접근 차단, 실제 로컬 PTY 명령, 정상 종료를 확인한다. 이 검사와 별도로 DMG의 Applications 이동, EXE 설치·제거, 한글 IME, 배율, 파일 대화상자, Keychain/DPAPI를 해당 OS에서 확인해야 한다. 패키지 내부 앱의 실행 성공을 설치 프로그램 검증으로 대신하지 않는다.

Windows 패키지 GUI와 실제 DPAPI 저장·재시작 후 접속을 검사하려면:

```powershell
$env:PASSPORT_DISABLE_UPDATE_CHECK = '1'
$env:PASSPORT_E2E_EXECUTABLE = (Resolve-Path 'release/win-unpacked/Passport.exe').Path
npx playwright test
```

ARM64에서는 실행 경로를 `release/win-arm64-unpacked/Passport.exe`로 바꾼다. DPAPI 시험은 `safeStorage`를 대체하지 않고 임시 프로필의 SQLite 암호문과 재시작 후 실제 SSH 비밀번호 인증을 확인한다.

시작 시 업데이트 확인을 실제 공개 GitHub 응답으로 검사하려면 다음을 실행한다. 별도 임시 프로필을 사용하며 수동 확인을 호출하지 않고 시작 시 확인 결과·About 표시·정상 종료를 검사한다. 인터넷 연결이 필요하다.

```sh
node scripts/updates-smoke.mjs release/mac-arm64/Passport.app/Contents/MacOS/Passport
```

Windows에서는 실제 `Passport.exe` 경로를 전달한다. 세 번째 인수로 화면 저장 폴더를 지정할 수 있으며 새 수동 검증은 `release/checks/<실행 ID>/updates`를 사용한다. 생략하면 기존 명령과의 호환을 위해 `release/recheck-updates-v<버전>`에 저장한다.

## 수동 CI

[Desktop verification](../.github/workflows/desktop.yml)은 `workflow_dispatch`로만 실행한다. Windows x64, Windows ARM64, Mac ARM64 작업에서 검사·GUI·패키징·패키지 실행 확인을 수행하고 설치 파일을 Actions artifact로 보관한다. Windows는 현재 사용자 설치 범위·보호 파일이 있는 드라이브 루트 목록·패키지 GUI·실제 DPAPI·네이티브 PTY 종료까지 추가로 확인한다. `--publish never`를 사용하므로 공개 Release를 게시하지 않는다.

Docker 매트릭스와 장시간 부하, 별도 Python 환경을 요구하는 FTP/FTPS 검사는 기본 CI만으로 모두 수행되지 않는다. [개발 안내](development.md)의 명령으로 따로 실행하고 건너뛴 시험을 기록한다. 실제 CI 실행 여부는 검증 기록에 남긴다.

## GitHub Release 게시

[Publish Mac release](../.github/workflows/release.yml)은 `v*.*.*` 태그 push에서 실행한다. 태그와 `package.json`의 버전이 같아야 하고 `docs/releases/v<버전>.md`가 있어야 한다. ARM64 Mac runner에서 기본 검사·GUI·DMG·패키지 실행과 구형 SSH/파일 색상을 확인하고 모든 단계가 통과하면 해당 버전의 GitHub Release에 DMG와 `SHA256SUMS.txt`를 게시한다. Windows 게시를 자동으로 시작하지 않는다. 게시 권한은 해당 작업의 저장소 contents로 한정한다. [GitHub ARM64 runner 공식 안내](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

[Publish Windows release](../.github/workflows/release-windows.yml)은 수동 `workflow_dispatch`로만 실행한다. 일반 브랜치 푸시나 Mac 게시로 설치본을 재배포하지 않는다. Windows x64 runner에서 Python FTP/FTPS fixture, Rust helper와 내장 Bash를 준비하고 `npm ci`·기본 검사·EXE 빌드·현재 사용자 설치 범위·실제 패키지 GUI를 검증한다. 통과하면 [게시 스크립트](../scripts/publish-windows-release.mjs)가 `package.json`과 같은 버전의 기존 정식 릴리즈에 EXE를 추가한다. 기존 Mac DMG와 체크섬을 검증·보존하고 합본 체크섬·Windows 소스 커밋을 게시한 뒤 공개 EXE를 다시 다운로드해 해시를 확인한다. 다른 바이트의 같은 이름 EXE가 이미 있거나 릴리즈가 불변 상태면 게시를 중단한다.

공개 배포 검증과 설치 파일 해시는 [검증 기록](verification.md)과 버전별 `docs/benchmarks/github-release-*.json`에 보관한다. 로컬 파일과 runner에서 만든 파일은 별도 빌드이므로 각각의 해시를 사용한다. Mac 배포 소스는 해당 버전 태그이며 Windows 수동 추가 게시 소스는 해당 `main` 빌드 커밋이다. Windows 게시 때문에 기존 릴리즈 태그를 옮기지 않고 게시 후 문서를 `main`에 반영한다.

## 배포 갱신 순서

1. 대상 OS에서 기본 검사와 패키지·설치 검증을 실행한다.
2. 빌드 버전, 아키텍처, 서명·공증 여부, SHA-256과 알려진 제한을 검증 기록에 남긴다.
3. 공개 배포 시 서명·공증과 다운로드 위치를 확정하고 실제 설치 파일을 게시한다.
4. [릴리즈 목록](releases/README.md)에 공개 날짜·상태·릴리즈 링크를 갱신한다. GitHub Release 본문은 `docs/releases/v<버전>.md`를 사용한다. README는 설치 방법·기능·플랫폼별 배포 상태가 바뀔 때 갱신한다.

Release 자산은 설치 파일과 `SHA256SUMS.txt`만 올린다. GitHub가 태그에서 자동으로 제공하는 **Source code (zip/tar.gz)** 링크는 직접 업로드한 자산이 아니다. [GitHub 릴리즈 공식 안내](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

1.0.1부터 설치된 앱이 시작할 때 공개 GitHub Releases API의 최신 정식 릴리즈를 한 번 확인한다. About에서도 같은 확인을 실행한다. 메인 프로세스가 버전을 숫자로 비교하고 공개된 설치 파일의 이름·OS·아키텍처·업로드 상태·다운로드 URL을 검증한다. 앱에는 GitHub 인증 토큰을 넣지 않으며 요청에 호스트·인증·설정 데이터를 포함하지 않는다. 동시 요청은 하나로 합치고 완료 후 5초 동안 결과를 재사용한다. 10초 제한·1MiB 응답 제한과 종료 시 요청 취소를 적용한다. 개발 실행에서는 시작 시 자동 조회를 생략하며 수동 확인은 가능하다. 패키지 fixture에서 외부 조회를 생략하려면 `PASSPORT_DISABLE_UPDATE_CHECK=1`을 사용한다.

설치 파일은 사용자가 버튼을 눌렀을 때 기본 브라우저로 다운로드한다. ad-hoc Mac 설치본의 앱 내부 자동 교체는 제공하지 않는다. 향후 `electron-updater`를 도입하려면 Developer ID 서명과 업데이트용 앱 ZIP·버전 메타데이터 게시를 함께 준비해야 한다. [자동 업데이트 공식 문서](https://www.electron.build/v26/docs/features/auto-update/).

같은 기기에서 앱을 종료하고 새 DMG·EXE로 기존 앱을 교체하면 기존 데이터를 유지한다. 설정 내보내기는 선택적인 별도 백업이다. DB 스키마가 바뀌는 버전은 기존 데이터 승격과 이전 버전 재사용 제한도 확인한다.

## 산출물 보관 규칙

`release/`는 로컬 작업용 산출물 보관소다. 공개 설치 파일의 기준은 GitHub Release, 장기 검증 기록의 기준은 `docs/verification.md`와 `docs/benchmarks/`다. 기능을 수정할 때마다 전체 앱 복사본을 무기한 보관하지 않는다.

### 저장 위치

| 경로                                        | 내용                                        | 기본 보관 기준                                                                                                      |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `release/builds/<실행 ID>/`                 | 패키징된 앱, 테스트용 DMG·EXE, builder 로그 | 플랫폼·아키텍처별 최근 성공 2회. 나머지 성공 결과는 7일 후 정리 후보, 재현 자료가 필요 없는 실패 결과는 1일 후 후보 |
| `release/packages/v<버전>/<출처>/<플랫폼>/` | 보관할 설치 파일과 SHA-256, 배포 메타데이터 | 플랫폼별 최신 공개 버전과 직전 공개 버전. 미공개 설치 파일은 현재 배포 후보 1개                                     |
| `release/checks/<실행 ID>/`                 | 스크린샷, trace, 로그, 검증 JSON·HTML       | 성공 자료는 요약 기록 후 7일. 실패 자료는 문제 해결 후 7일                                                          |
| `release/backups/<실행 ID>/`                | 설치 교체 직전 앱과 사용자 DB의 복구 세트   | 플랫폼별 검증된 최근 2세트 보존. 그보다 오래된 세트는 최소 7일 경과하고 새 설치본의 정상 동작을 확인한 뒤 정리 후보 |

Mac에서 바로 테스트할 앱은 **`release/builds/Passport.app`**이다. 최근 검증한 빌드의 실제 앱을 가리키는 상대 심볼릭 링크이며 별도 앱 복사본은 아니다. 새 빌드의 검증이 끝나면 링크 대상을 갱신하고 현재 대상은 정리에서 제외한다. 다른 Passport가 같은 사용자 데이터로 실행 중이면 완전히 종료한 뒤 연다. 현재 대상과 해시는 각 빌드의 `artifact.json`과 최신 검증 기록에서 확인한다.

보관 기준은 **정리 후보를 고르는 규칙**이며 자동 삭제 작업이 아니다. 최근 성공 2회와 최근 복구 2세트는 날짜가 오래돼도 유지한다. 설치 파일은 GitHub에 게시된 바이트와 체크섬을 확인한 뒤 이전 로컬 사본을 정리한다. 폴더 용량만으로 사용자 DB나 복구 세트를 삭제하지 않는다.

실행 ID는 `UTC시각-커밋7자리-플랫폼-용도`로 통일한다. 예: `20261001T045129Z-4d2940c-mac-arm64-colors`. 커밋하지 않은 변경이 있으면 커밋 뒤에 `-dirty`를 붙이고, 실행 시점의 변경 파일 목록과 실제 산출물 해시도 남긴다. 같은 초에 겹치면 번호를 붙인다. 플랫폼은 `mac-arm64`, `win-x64`, `win-arm64`를 사용한다.

패키지 출처는 `local`과 `github`를 구분한다. 같은 버전의 로컬 빌드와 공개 파일은 해시가 다를 수 있으므로 서로 덮어쓰지 않는다. 예: `packages/v1.0.2/github/mac-arm64/Passport-1.0.2-mac-arm64.dmg`. 추가 후보를 비교해야 하면 `builds/`에서 검증하고 확정한 1개만 `packages/`에 보관한다.

각 실행 폴더에는 `artifact.json`을 남긴다. `createdAt`(UTC), `purpose`, `sourceCommit`, `dirty`, `platform`, `source`(로컬 또는 공개 다운로드), `status`(진행 중·성공·실패), 검증 요약, 실제 파일 경로와 SHA-256, 연결된 검증·백업 경로를 기록한다. 백업에는 DB 무결성 확인 여부와 복구 대상 앱도 기록한다. 파일이 비어 있거나 검증하지 않은 백업은 성공으로 표시하지 않는다. 인증 정보나 사용자 DB 내용은 메타데이터에 넣지 않는다.

### 생성과 정리 절차

1. 실행 전에 목적에 맞는 폴더를 정한다. 수동 electron-builder 실행은 `--config.directories.output=release/builds/<실행 ID>`로 출력을 지정한다. 검증 자료는 대응하는 `checks/<실행 ID>`에 모은다. `fix-preview`, `recheck-*`, `installed-*-backup-*` 같은 새 폴더를 루트에 추가하지 않는다.
2. 같은 빌드에서 얻은 앱·DMG·검증 자료를 서로 연결하고, 최종 설치 파일만 `packages/`로 옮긴다. 같은 앱을 이름만 바꾸어 여러 번 백업하지 않는다. 실제 앱과 DB의 복구 세트는 `backups/`에 보관한다.
3. 검증 결과와 공개 파일 해시를 장기 문서에 기록한다. 과거 문서의 파일 경로는 당시 실행 기록이므로 다른 빌드로 덮어쓰지 않는다. 파일을 이동하거나 정리하면 이전 경로·새 경로 또는 삭제 사실을 기록한다. 계속 보여 줘야 할 대표 이미지는 기존 문서 자산 위치에 보관한다.
4. 작업을 마칠 때 용량과 보관 기준을 넘은 후보를 확인한다. 보존해야 할 예외에는 `KEEP.md`로 이유·관련 이슈·재검토일을 남긴다. 진행 중인 작업과 실행·마운트 중인 앱, 미해결 문제의 자료도 후보에서 제외한다.
5. 정리 요청을 받으면 대상 경로·크기·남길 복구 세트를 먼저 확인한 뒤 해당 후보만 정리한다. `release/` 전체를 일괄 삭제하지 않는다. 메타데이터가 없는 기존 폴더는 검증 기록과 내용을 대조해 분류한 뒤 처리한다. 백업과 재현 자료는 확인되지 않았다는 이유만으로 지우지 않는다.

### 기존 폴더의 분류와 적용 범위

2026-10-01 로컬 조사에서 `release/`의 디스크 사용량은 약 **6.3GiB**였다. 아래는 정리 전 분류다. 같은 날 사용자 요청으로 네 가지 폴더에 분류하고 중복 앱·이전 로컬 설치 파일·중간 결과를 정리해 **약 4.8GiB**로 줄였다. [이동 경로·삭제 목록·해시 검증 기록](benchmarks/release-cleanup-20261001.json)을 함께 확인한다.

| 기존 항목                                                                                                                                  | 분류 및 처리 기준                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `local-ai-preview`, `local-terminal-preview`, `icon-fix-preview`, `notification-fix-preview`, `startup-fix-preview`, `local-color-preview` | 빌드 6개, 약 2.2GiB. `builds/` 대상이며 최근 성공 2회와 재현에 필요한 빌드를 식별한다                                       |
| `mac-arm64`, `v0.3.2`, `recheck-20260930`                                                                                                  | 빌드 결과. 들어 있는 설치 파일과 검증 자료는 각각 별도 분류한다                                                             |
| `Passport-*.dmg`, `github-v*`, SHA-256·게시 결과 파일                                                                                      | 로컬/공개 출처를 확인해 `packages/`에 분류한다. 과거 설치본은 보관 기준과 공개 파일 확인 후 후보로 정한다                   |
| `recheck-ui-*`, `recheck-spaces-*`, `recheck-updates-*`, `icon-review`                                                                     | `checks/` 대상. 문서에서 참조하는 대표 자료와 미해결 문제 자료를 먼저 확인한다                                              |
| `installed-backup-20261001-130506`, `installed-color-backup-20261001-133159`                                                               | 복구 백업, 합계 약 1.1GiB. 앱·DB 세트를 유지한다. 첫 폴더의 앱 사본 2개는 내용과 복구 용도를 확인한 뒤 중복 여부를 판단한다 |
| `installed-color-backup-20261001-133053`                                                                                                   | DB가 0바이트인 실패 시도. 복구 가능한 백업 수에 포함하지 않는다                                                             |
| `builder-debug.yml`, `.icon-icns`, `.DS_Store`                                                                                             | 빌드 로그·중간 결과·OS 메타데이터. 관련 작업 종료와 재현 필요 여부 확인 후 정리 후보                                        |

기존 자료의 정확한 소스 커밋을 알 수 없는 경우에는 실행 ID에 `legacy`, 메타데이터의 `sourceCommit`에 `null`을 사용했다. 과거 검증 결과를 확인하지 못한 자료는 `legacy-unclassified`로 표시하고, 이번 이동의 해시 검증과 원래 빌드의 성공 여부를 구분했다. 원래 폴더 수정 시각을 이용한 날짜에도 그 출처를 기록했다.

공개 설치본 1.0.2·1.0.1과 마지막 로컬 DMG, 검증된 복구 백업 2세트를 보관했다. 보관한 앱·DMG·DB 18개의 내용 해시가 동일하고 백업 DB 2개가 `quick_check`를 통과했다. 최근 성공 미리보기 2개는 보존 대상으로 표시했다. 다른 고유 빌드와 검증 자료도 생성 후 7일이 지나지 않아 유지했다. 삭제한 오래된 로컬 설치 파일은 공개 설치 파일과 다른 빌드였으며, 동일하다고 간주해 삭제한 것이 아니다.

새 수동 작업부터 이 규칙을 사용한다. 현재 `package.json`, CI, 기존 smoke·게시 스크립트는 아직 `release/` 루트를 사용하므로 경로 전환 전까지 기존 출력에 한해 허용한다. 이번 정리는 기존 산출물의 분류·이동·삭제이며 자동 출력 경로 변경, 자동 정리 명령이나 스케줄은 포함하지 않는다.
