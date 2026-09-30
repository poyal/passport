# 패키징과 배포 안내

[전체 문서](README.md) · [개발 환경](development.md) · [검증 결과](verification.md)

이 문서는 설치본을 만드는 개발자용 안내다. 최종 사용자의 설치 방법은 [제품 README](../README.md#설치)에 둔다.

## 현재 상태

2026-09-30 기준 버전은 1.0.0이다. Apple Silicon Mac용 테스트 DMG를 생성하고 실제 패키지 실행을 확인했다. Windows x64·ARM64는 빌드 스크립트와 수동 CI를 준비했으나 실제 설치·실행 확인이 남아 있다. 공개 다운로드 페이지나 GitHub Release를 게시하지 않았다.

Mac 설치본은 ad-hoc 서명이며 Developer ID 서명·Apple 공증을 포함하지 않는다. `codesign` 무결성 검사 통과는 Apple 공증이나 Gatekeeper의 실행 허용을 뜻하지 않는다. 현재 결과와 DMG 해시는 [검증 기록](verification.md)에 보관한다.

## 대상별 빌드

각 대상 OS와 아키텍처의 네이티브 환경에서 `npm ci`와 기본 검사를 먼저 수행한다.

| 대상                | 명령                     | 결과 파일                              |
| ------------------- | ------------------------ | -------------------------------------- |
| macOS Apple Silicon | `npm run dist:mac`       | `release/Passport-1.0.0-mac-arm64.dmg` |
| Windows x64         | `npm run dist:win`       | `release/Passport-1.0.0-win-x64.exe`   |
| Windows ARM64       | `npm run dist:win:arm64` | `release/Passport-1.0.0-win-arm64.exe` |

파일 이름의 버전은 `package.json`을 따른다. `npm run pack`은 설치 프로그램 없이 현재 환경의 앱 폴더를 만든다. `release/`와 `dist/`는 생성물이며 저장소에 커밋하지 않는다. README의 다운로드 링크는 실제 게시된 설치 파일이 있을 때 추가한다.

Mac 최소 버전 목표는 14, 현재 실측은 macOS 27이다. Windows 대상은 Windows 11 x64·ARM64이며 각각의 설치 및 실행 검증을 구분한다. Intel Mac과 Rosetta 의존 Mac 패키지는 만들지 않는다.

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

## 수동 CI

[Desktop verification](../.github/workflows/desktop.yml)은 `workflow_dispatch`로만 실행한다. Windows x64, Windows ARM64, Mac ARM64 작업에서 검사·GUI·패키징·패키지 실행 확인을 수행하고 설치 파일을 Actions artifact로 보관한다. `--publish never`를 사용하므로 공개 Release를 게시하지 않는다.

Docker 매트릭스와 장시간 부하, 별도 Python 환경을 요구하는 FTP/FTPS 검사는 기본 CI만으로 모두 수행되지 않는다. [개발 안내](development.md)의 명령으로 따로 실행하고 건너뛴 시험을 기록한다. 실제 CI 실행 여부는 검증 기록에 남긴다.

## 배포 갱신 순서

1. 대상 OS에서 기본 검사와 패키지·설치 검증을 실행한다.
2. 빌드 버전, 아키텍처, 서명·공증 여부, SHA-256과 알려진 제한을 검증 기록에 남긴다.
3. 공개 배포 시 서명·공증과 다운로드 위치를 확정하고 실제 설치 파일을 게시한다.
4. 게시된 파일과 일치하도록 README의 제공 상태·파일 이름·다운로드 링크와 필요 시 스크린샷을 갱신한다.

자동 업데이트 기능은 제공하지 않는다. 사용자는 설정을 내보낸 뒤 새 DMG·EXE를 설치한다. DB 스키마가 바뀌는 버전은 기존 데이터 승격과 이전 버전 재사용 제한도 확인한다.
