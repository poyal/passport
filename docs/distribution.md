# 패키징과 배포 안내

[전체 문서](README.md) · [개발 환경](development.md) · [검증 결과](verification.md)

이 문서는 설치본을 만드는 개발자용 안내다. 최종 사용자의 설치 방법은 [제품 README](../README.md#설치)에 둔다.

## 현재 상태

공개 버전과 준비 중인 버전은 [릴리즈 목록](releases/README.md)에서 확인한다. Apple Silicon Mac용 DMG와 SHA256SUMS를 GitHub Release에 게시한다. Windows x64·ARM64는 빌드 스크립트와 수동 CI를 준비했으나 실제 설치·실행 확인이 남아 있다.

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

시작 시 업데이트 확인을 실제 공개 GitHub 응답으로 검사하려면 다음을 실행한다. 별도 임시 프로필을 사용하며 수동 확인을 호출하지 않고 시작 시 확인 결과·About 표시·정상 종료를 검사한다. 인터넷 연결이 필요하다.

```sh
node scripts/updates-smoke.mjs release/mac-arm64/Passport.app/Contents/MacOS/Passport
```

## 수동 CI

[Desktop verification](../.github/workflows/desktop.yml)은 `workflow_dispatch`로만 실행한다. Windows x64, Windows ARM64, Mac ARM64 작업에서 검사·GUI·패키징·패키지 실행 확인을 수행하고 설치 파일을 Actions artifact로 보관한다. `--publish never`를 사용하므로 공개 Release를 게시하지 않는다.

Docker 매트릭스와 장시간 부하, 별도 Python 환경을 요구하는 FTP/FTPS 검사는 기본 CI만으로 모두 수행되지 않는다. [개발 안내](development.md)의 명령으로 따로 실행하고 건너뛴 시험을 기록한다. 실제 CI 실행 여부는 검증 기록에 남긴다.

## GitHub Release 게시

[Publish Mac release](../.github/workflows/release.yml)은 `v*.*.*` 태그 push에서 실행한다. 태그와 `package.json`의 버전이 같아야 하고 `docs/releases/v<버전>.md`가 있어야 한다. ARM64 Mac runner에서 기본 검사·GUI·DMG·패키지 실행과 구형 SSH/파일 색상을 확인하고 모든 단계가 통과하면 해당 버전의 GitHub Release에 DMG와 `SHA256SUMS.txt`를 게시한다. 게시 권한은 해당 작업의 저장소 contents로 한정한다. [GitHub ARM64 runner 공식 안내](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

공개 배포 검증과 설치 파일 해시는 [검증 기록](verification.md)과 버전별 `docs/benchmarks/github-release-v<버전>.json`에 보관한다. 로컬 DMG와 runner에서 만든 DMG는 별도 빌드이므로 각각의 해시를 사용한다. 배포 소스는 해당 버전 태그를 기준으로 하며 게시 후 문서 갱신은 `main`에 반영한다.

## 배포 갱신 순서

1. 대상 OS에서 기본 검사와 패키지·설치 검증을 실행한다.
2. 빌드 버전, 아키텍처, 서명·공증 여부, SHA-256과 알려진 제한을 검증 기록에 남긴다.
3. 공개 배포 시 서명·공증과 다운로드 위치를 확정하고 실제 설치 파일을 게시한다.
4. [릴리즈 목록](releases/README.md)에 공개 날짜·상태·릴리즈 링크를 갱신한다. GitHub Release 본문은 `docs/releases/v<버전>.md`를 사용한다. README는 설치 방법·기능·지원 플랫폼이 바뀔 때 갱신하며 버전별 날짜와 파일 이름은 넣지 않는다.

Release 자산은 설치 파일과 `SHA256SUMS.txt`만 올린다. GitHub가 태그에서 자동으로 제공하는 **Source code (zip/tar.gz)** 링크는 직접 업로드한 자산이 아니다. [GitHub 릴리즈 공식 안내](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

1.0.1부터 설치된 앱이 시작할 때 공개 GitHub Releases API의 최신 정식 릴리즈를 한 번 확인한다. About에서도 같은 확인을 실행한다. 메인 프로세스가 버전을 숫자로 비교하고 공개된 설치 파일의 이름·OS·아키텍처·업로드 상태·다운로드 URL을 검증한다. 앱에는 GitHub 인증 토큰을 넣지 않으며 요청에 호스트·인증·설정 데이터를 포함하지 않는다. 동시 요청은 하나로 합치고 완료 후 5초 동안 결과를 재사용한다. 10초 제한·1MiB 응답 제한과 종료 시 요청 취소를 적용한다. 개발 실행에서는 시작 시 자동 조회를 생략하며 수동 확인은 가능하다. 패키지 fixture에서 외부 조회를 생략하려면 `PASSPORT_DISABLE_UPDATE_CHECK=1`을 사용한다.

설치 파일은 사용자가 버튼을 눌렀을 때 기본 브라우저로 다운로드한다. ad-hoc Mac 설치본의 앱 내부 자동 교체는 제공하지 않는다. 향후 `electron-updater`를 도입하려면 Developer ID 서명과 업데이트용 앱 ZIP·버전 메타데이터 게시를 함께 준비해야 한다. [자동 업데이트 공식 문서](https://www.electron.build/v26/docs/features/auto-update/).

같은 기기에서 앱을 종료하고 새 DMG·EXE로 기존 앱을 교체하면 기존 데이터를 유지한다. 설정 내보내기는 선택적인 별도 백업이다. DB 스키마가 바뀌는 버전은 기존 데이터 승격과 이전 버전 재사용 제한도 확인한다.
