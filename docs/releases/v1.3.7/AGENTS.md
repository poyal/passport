# Passport 1.3.7 검증 기록

2026-10-25 [v1.3.7](https://github.com/poyal/passport/releases/tag/v1.3.7)을 Mac ARM64·Windows x64로 공개했습니다. 두 설치 파일의 소스와 태그는 모두 `c3007299bbb07a8851ef2d17763b5a663e2e0e13`입니다. 이 결과를 확정한 후속 문서 커밋은 배포 바이너리의 소스가 아닙니다.

Windows Ctrl+C의 선택 복사·선택 없는 중단, 편집 메뉴의 터미널 제어키 가로채기, 일반 셸의 Codex·Claude 실행 감지, 비패키지 개발 앱과 정식 앱의 식별자 분리를 포함합니다. 사용법은 [1.3.7 사용자 매뉴얼](README.md), 절차는 [릴리즈 가이드](../../release.md)를 따릅니다.

## 검증 소스와 환경

| 대상 | 정식 실행 ID | 환경 |
| --- | --- | --- |
| Windows x64 | `20261025T061104Z-c300729-win-x64-local-release` | Windows 11 10.0.26300, Node 24.14.0, npm 11.21.1, Python 3.13.7, OpenSSL 3.5.7, PowerShell 7.6.6·Windows PowerShell 5.1, MSVC |
| Mac ARM64 | `20261025T061819Z-c300729-mac-arm64-local-release` | Mac mini, macOS 27.0.1, Node 24.21.0, npm 11.19.0, Python 3.13.7, LibreSSL 3.3.6, Xcode Command Line Tools |

공통 Rust는 공식 배포의 1.99.1, Electron은 잠금 의존성의 44.8.0입니다. Rust는 각 저장소의 작업 전용 경로에 준비했고 시스템 PATH는 변경하지 않았습니다. Windows 내장 Bash는 고정 해시를 확인한 Portable Git 2.56.0.windows.2입니다. 각 OS에서 `npm ci`와 Electron ABI 네이티브 모듈 준비를 다시 수행했습니다.

사용자가 두 OS의 실제 데스크톱 검사와 게시를 명시적으로 허용한 뒤 같은 깨끗한 소스에서 `release:verify -- --desktop`을 수행했습니다. 최종 manifest는 각각 `status: verified`, `preview: false`입니다.

## 최종 검사 결과

| 검사 | Windows x64 | Mac ARM64 |
| --- | --- | --- |
| 의존성·FTP/FTPS·타입·Rust·앱 빌드 | 통과 | 통과 |
| 단위·통합 | 278 통과·10 생략 | 281 통과·7 생략 |
| 배포 정책 | 83 통과·1 생략 | 84 통과 |
| 소스 앱 숨김 GUI | 100 통과·8 생략 | 98 통과·10 생략 |
| 소스 앱 실제 데스크톱 | 4 통과 | 4 통과 |
| 설치 파일·내부 앱 실행 | NSIS 범위·페이로드·PTY·helper·정상 종료 통과 | DMG·codesign 무결성·실제 Keychain 암호화 왕복·PTY·helper·정상 종료 통과 |
| 최종 설치 파일 내부 앱 숨김 GUI | 100 통과·8 생략 | 98 통과·10 생략 |
| 최종 설치 파일 내부 앱 실제 데스크톱 | 4 통과 | 4 통과 |

단위 생략은 Windows의 다른 OS용 8개와 Mac의 다른 OS용 5개, 각 OS의 미선택 Docker·파일 부하 2개입니다. 배포 정책의 Windows 1개는 심볼릭 링크 사례입니다. GUI 생략은 Windows의 Mac 전용 4개, Mac의 Windows 전용 6개와 각 OS의 미선택 Docker·지속 UI 부하·대용량 텍스트·설치된 실제 AI CLI 4개입니다. 네 종류 Windows 셸·DPAPI 저장 및 재시작·드라이브 탐색은 생략하지 않았습니다.

최종 정식 실행의 필수 사례 실패·재시도·flaky는 0입니다. 소스·설치본의 숨김 수명 감사 결과는 각 OS에서 서로 같습니다.

| 대상 | 시작 / 정상 종료 / 종료 감사 | 창 | 앱 재사용 | 표시 / 네이티브 포커스 |
| --- | --- | ---: | ---: | --- |
| Windows 소스·설치본 각각 | 48 / 48 / 48 | 59 | 43 | 0 / 0 |
| Mac 소스·설치본 각각 | 45 / 45 / 45 | 57 | 40 | 0 / 0 |

실제 데스크톱 단계도 각 실행의 앱 4개가 정상 종료했습니다. 정상 종료 제한을 늘리거나 강제 종료를 성공으로 간주하지 않았습니다.

AI 감지 회귀는 PowerShell 7·Windows PowerShell 5.1·cmd·Passport Bash·macOS zsh·bash에서 실제 PTY와 시험용 Codex·Claude를 사용했습니다. 알림·복원·시작 프로파일을 끈 상태의 아이콘 전환, 한글·공백 인수 전달, Ctrl+C 종료와 셸 복귀를 확인했습니다. 사용자 별칭·함수·앞선 PATH·절대 경로로 Passport 실행기를 우회하는 경우는 자동 감지 범위 밖입니다.

## 초기 실패와 재개

초기 Mac 사전 GUI에서는 사용자 zsh 설정이 시험용 CLI보다 실제 Codex 경로를 앞세웠습니다. 시험용 ZDOTDIR과 UTF-8 로케일을 격리하고 원래 환경을 복구하도록 수정한 뒤 관련 GUI 3개와 전체 정식 검증을 통과했습니다. Electron의 HOME과 사용자 셸 파일은 변경하지 않았습니다. 구 후보의 Windows 사전 검증은 소스 GUI 100개 통과 후 새 정식 후보로 전환하기 위해 패키징 단계에서 중단했으며 게시에 사용하지 않았습니다.

첫 Mac 정식 실행 `20261025T061103Z-c300729-mac-arm64-local-release`은 SSH `Background` 보안 세션에서 키체인 상호작용이 거부돼 설치 파일 검사에 실패했습니다. 같은 사용자의 GUI 로그인 세션에서 정상 조회를 확인한 뒤 일회성 LaunchAgent로 전체 정식 검증을 새로 실행했습니다. 키체인 접근 제어·암호화 정책을 바꾸거나 평문 저장·mock으로 우회하지 않았습니다. 성공한 최종 DMG의 Keychain 암호화·복호화·정상 종료를 실제로 확인했습니다.

## 공개 설치 파일

| 파일 | 크기(바이트) | SHA-256 |
| --- | ---: | --- |
| `Passport-1.3.7-mac-arm64.dmg` | 174,269,883 | `a2928bbebeef2a4a5ce862bf7304c8074b2b9ed187d4d1e27e939742618306d9` |
| `Passport-1.3.7-win-x64.exe` | 207,332,582 | `69cba5ade99e47ecaffea7b0e273cc3b316a3ab32483d55fe0fe250c85146abe` |
| `SHA256SUMS.txt` | 188 | `4a6a6fe32f3926fcb97c69a7eb57ac368a1d495dbffb776f294375141aa8edcf` |

검증한 원본 DMG·EXE와 증거 파일을 취합해 한 번에 게시했습니다. 게시 도구 결과는 `published-and-download-verified`입니다. 별도의 인증 없는 공개 URL 다운로드에서도 두 설치 파일과 통합 체크섬의 크기·SHA-256을 대조했고 최신 릴리즈 API가 `v1.3.7`을 반환함을 확인했습니다. GitHub 릴리즈 ID는 `423188624`, 공개 시각은 2026-10-25 15:29:43 KST입니다. 기존 버전 태그·설치 파일은 교체하지 않았습니다.

Mac 앱은 ad-hoc 서명이며 Developer ID·Apple 공증은 포함하지 않습니다. Windows EXE에는 Authenticode 서명이 없습니다. 사용자 설치 앱·실제 Passport DB는 교체하지 않았습니다.

## 별도 확인 범위와 제한

최소 지원 macOS 14 실기, 물리 IME, 실제 OS 알림 표시, 다른 PC와의 LAN, 유료 AI 서비스·설치된 실제 AI CLI 선택 검사, 깨끗한 계정의 설치·제거·업그레이드, Docker·장시간 부하는 이번 범위에 포함하지 않았습니다. 다른 버전이나 다른 소스의 검증 결과를 이번 설치 파일의 결과로 사용하지 않습니다.
