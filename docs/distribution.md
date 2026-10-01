# 패키징과 배포 안내

[전체 문서](README.md) · [개발 환경](development.md) · [검증 결과](verification.md)

이 문서는 설치본을 만드는 개발자용 안내다. 최종 사용자의 설치 방법은 [제품 README](../README.md#설치)에 둔다.

## 현재 상태

공개 버전과 준비 중인 버전은 [릴리즈 목록](releases/README.md)에서 확인한다. Apple Silicon Mac용 DMG와 Windows x64 EXE를 GitHub Release에 게시하며 `SHA256SUMS.txt`에 두 플랫폼의 체크섬을 제공한다. Windows x64는 로컬 실제 설치·PTY·DPAPI·종료·제거, Docker SSH/SFTP 8개 구성과 대용량·지속 출력 검사에 이어 원격 Windows 빌드·검증을 완료했다. Windows ARM64의 실제 설치·실행은 아직 확인하지 않았다. 공개 파일 해시와 로컬 전체 시험 범위는 [검증 기록](verification.md)을 따른다.

Mac 설치본은 ad-hoc 서명이며 Developer ID 서명·Apple 공증을 포함하지 않는다. `codesign` 무결성 검사 통과는 Apple 공증이나 Gatekeeper의 실행 허용을 뜻하지 않는다. 현재 결과와 DMG 해시는 [검증 기록](verification.md)에 보관한다.

## 대상별 빌드

각 대상 OS와 아키텍처의 네이티브 환경에서 `npm ci`와 기본 검사를 먼저 수행한다.

| 대상                | 명령                     | 결과 파일                                  |
| ------------------- | ------------------------ | ------------------------------------------ |
| macOS Apple Silicon | `npm run dist:mac`       | `release/Passport-<version>-mac-arm64.dmg` |
| Windows x64         | `npm run dist:win`       | `release/Passport-<version>-win-x64.exe`   |
| Windows ARM64       | `npm run dist:win:arm64` | `release/Passport-<version>-win-arm64.exe` |

파일 이름의 버전은 `package.json`을 따른다. `npm run pack`은 설치 프로그램 없이 현재 환경의 앱 폴더를 만든다. `release/`와 `dist/`는 생성물이며 저장소에 커밋하지 않는다. README는 최신 공개 릴리즈 링크를 유지하고 버전별 링크는 릴리즈 목록에 추가한다.

Mac 최소 버전 목표는 14이며 macOS 27 로컬 환경과 macOS 15 GitHub Actions에서 앱 실행을 확인했다. Windows 대상은 Windows 11 x64·ARM64이며 각각의 설치 및 실행 검증을 구분한다. Intel Mac과 Rosetta 의존 Mac 패키지는 만들지 않는다.

Windows의 `npm ci`는 네이티브 재컴파일 후 [ConPTY 배치 스크립트](../scripts/prepare-node-pty.mjs)로 DLL·OpenConsole을 실제 네이티브 모듈 옆에 복사한다. 패키징의 [afterPack](../scripts/after-pack.mjs)에서도 다시 배치한다. electron-builder 재컴파일이 node-pty의 원래 postinstall 복사 결과를 지워도 패키지에 필요한 파일을 포함하도록 한다.

Windows NSIS 설치본은 [설치 스크립트](../build/installer.nsh)에서 현재 사용자 전용으로 고정한다. 사용자 범위 선택 화면을 생략하고 설치 폴더 선택은 유지한다. 관리자 권한 상승과 `/allusers` 재정의를 허용하지 않는다. 생성된 설치본의 첫 화면과 명령줄 재정의를 검사하려면 다음을 실행한다. 검사 결과 JSON은 설치본과 같은 폴더에 저장된다.

```powershell
./scripts/windows-installer-smoke.ps1 -InstallerPath release/Passport-1.0.2-win-x64.exe
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

## 수동 CI

[Desktop verification](../.github/workflows/desktop.yml)은 `workflow_dispatch`로만 실행한다. Windows x64, Windows ARM64, Mac ARM64 작업에서 검사·GUI·패키징·패키지 실행 확인을 수행하고 설치 파일을 Actions artifact로 보관한다. Windows는 현재 사용자 설치 범위·보호 파일이 있는 드라이브 루트 목록·패키지 GUI·실제 DPAPI·네이티브 PTY 종료까지 추가로 확인한다. `--publish never`를 사용하므로 공개 Release를 게시하지 않는다.

Docker 매트릭스와 장시간 부하, 별도 Python 환경을 요구하는 FTP/FTPS 검사는 기본 CI만으로 모두 수행되지 않는다. [개발 안내](development.md)의 명령으로 따로 실행하고 건너뛴 시험을 기록한다. 실제 CI 실행 여부는 검증 기록에 남긴다.

## GitHub Release 게시

[Publish Mac release](../.github/workflows/release.yml)은 `v*.*.*` 태그 push에서 실행한다. 태그와 `package.json`의 버전이 같아야 하고 `docs/releases/v<버전>.md`가 있어야 한다. ARM64 Mac runner에서 기본 검사·GUI·DMG·패키지 실행과 구형 SSH/파일 색상을 확인하고 모든 단계가 통과하면 해당 버전의 GitHub Release에 DMG와 `SHA256SUMS.txt`를 게시한다. 게시 권한은 해당 작업의 저장소 contents로 한정한다. [GitHub ARM64 runner 공식 안내](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

[Publish Windows release](../.github/workflows/release-windows.yml)은 `workflow_dispatch`로만 실행한다. 소스나 워크플로 수정의 푸시만으로 설치본을 재배포하지 않는다. Windows x64 runner에서 Python FTP/FTPS fixture, Rust helper와 내장 Bash를 준비하고 `npm ci`·기본 검사·EXE 빌드·현재 사용자 설치 범위·실제 패키지 GUI를 검증한다. 통과하면 [게시 스크립트](../scripts/publish-windows-release.mjs)가 `package.json`과 같은 버전의 기존 정식 릴리즈에 EXE를 추가한다. 기존 Mac DMG와 체크섬을 검증·보존하고 합본 체크섬·Windows 소스 커밋을 게시한 뒤 공개 EXE를 다시 다운로드해 해시를 확인한다. 다른 바이트의 같은 이름 EXE가 이미 있거나 릴리즈가 불변 상태면 게시를 중단한다.

공개 배포 검증과 설치 파일 해시는 [검증 기록](verification.md)과 버전별 `docs/benchmarks/github-release-*.json`에 보관한다. 로컬 파일과 runner에서 만든 파일은 별도 빌드이므로 각각의 해시를 사용한다. Mac 배포 소스는 해당 버전 태그이며 Windows 추가 게시 소스는 해당 `main` 빌드 커밋이다. Windows 게시 때문에 기존 Mac 태그를 옮기지 않고 게시 후 문서를 `main`에 반영한다.

## 배포 갱신 순서

1. 대상 OS에서 기본 검사와 패키지·설치 검증을 실행한다.
2. 빌드 버전, 아키텍처, 서명·공증 여부, SHA-256과 알려진 제한을 검증 기록에 남긴다.
3. 공개 배포 시 서명·공증과 다운로드 위치를 확정하고 실제 설치 파일을 게시한다.
4. [릴리즈 목록](releases/README.md)에 공개 날짜·상태·릴리즈 링크를 갱신한다. GitHub Release 본문은 `docs/releases/v<버전>.md`를 사용한다. README는 설치 방법·기능·지원 플랫폼이 바뀔 때 갱신하며 버전별 날짜와 파일 이름은 넣지 않는다.

Release 자산은 설치 파일과 `SHA256SUMS.txt`만 올린다. GitHub가 태그에서 자동으로 제공하는 **Source code (zip/tar.gz)** 링크는 직접 업로드한 자산이 아니다. [GitHub 릴리즈 공식 안내](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

1.0.1부터 설치된 앱이 시작할 때 공개 GitHub Releases API의 최신 정식 릴리즈를 한 번 확인한다. About에서도 같은 확인을 실행한다. 메인 프로세스가 버전을 숫자로 비교하고 공개된 설치 파일의 이름·OS·아키텍처·업로드 상태·다운로드 URL을 검증한다. 앱에는 GitHub 인증 토큰을 넣지 않으며 요청에 호스트·인증·설정 데이터를 포함하지 않는다. 동시 요청은 하나로 합치고 완료 후 5초 동안 결과를 재사용한다. 10초 제한·1MiB 응답 제한과 종료 시 요청 취소를 적용한다. 개발 실행에서는 시작 시 자동 조회를 생략하며 수동 확인은 가능하다. 패키지 fixture에서 외부 조회를 생략하려면 `PASSPORT_DISABLE_UPDATE_CHECK=1`을 사용한다.

설치 파일은 사용자가 버튼을 눌렀을 때 기본 브라우저로 다운로드한다. ad-hoc Mac 설치본의 앱 내부 자동 교체는 제공하지 않는다. 향후 `electron-updater`를 도입하려면 Developer ID 서명과 업데이트용 앱 ZIP·버전 메타데이터 게시를 함께 준비해야 한다. [자동 업데이트 공식 문서](https://www.electron.build/v26/docs/features/auto-update/).

같은 기기에서 앱을 종료하고 새 DMG·EXE로 기존 앱을 교체하면 기존 데이터를 유지한다. 설정 내보내기는 선택적인 별도 백업이다. DB 스키마가 바뀌는 버전은 기존 데이터 승격과 이전 버전 재사용 제한도 확인한다.
