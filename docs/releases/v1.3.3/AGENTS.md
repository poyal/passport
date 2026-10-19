# Passport 1.3.3 AI 기록

이 문서는 1.3.3의 배포 소스·검증 환경·최종 결과·남은 제한을 기록합니다. 공통 작업 지침은 [루트 AGENTS](../../../AGENTS.md), 개발·E2E·문서 규칙은 [공통 개발 규칙](../../development.md), 검증·게시·정리 절차는 [릴리즈 가이드](../../release.md)를 따릅니다. 사용자 조작은 [1.3.3 매뉴얼](README.md)에서 확인합니다.

## 버전별 데이터와 화면 기준

SQLite 스키마는 5, 문서·portable 형식은 2입니다. 매뉴얼 전체 화면은 1.3.1 최종 Mac 앱에서, 앱 내부 쪽지 가이드의 두 부분 화면은 1.3.1 Windows UI에서 격리된 예제 데이터로 촬영했습니다. 변경되지 않은 화면을 재사용하며 1.3.3에서 새로 촬영한 화면으로 표시하지 않습니다.

## 검증과 공개 상태

2026-10-19에 [v1.3.3](https://github.com/poyal/passport/releases/tag/v1.3.3)을 **Mac ARM64·Windows x64 모두 공개**했습니다. 두 설치 파일의 소스와 태그는 `cf910f8f57c4ef91b608dad4401943704dbad0b6`입니다. 게시 결과는 `published-and-download-verified`이며, 두 설치 파일과 합본 `SHA256SUMS.txt`의 공개 다운로드를 확인했습니다. 이 최종 기록을 반영하는 후속 문서 커밋은 배포 바이너리의 소스 커밋과 구분합니다. 사용자 설치본은 교체하지 않았습니다.

## 정식 검증 환경과 결과

사용자가 두 OS의 실제 데스크톱 검사를 허용한 뒤 같은 깨끗한 커밋에서 `release:verify -- --desktop`을 수행했습니다. 두 OS 모두 `preview: false`, `status: verified`이며, GUI 실패·재시도·flaky는 없습니다.

| 환경 | Mac | Windows |
| --- | --- | --- |
| OS·아키텍처 | macOS 27.0.1, arm64 | Windows 11 빌드 26300, x64 |
| Node.js·npm | 24.21.0 · 11.19.0 | 24.14.0 · 11.21.1 |
| Rust Cargo·Electron | 1.99.0 · 44.8.0 | 1.98.1 · 44.8.0 |

| 검사 | Mac | Windows |
| --- | --- | --- |
| 잠금 의존성·FTP/FTPS fixture·빌드 | 통과 | 통과 |
| 단위·통합 | 249 통과·7 생략 | 249 통과·7 생략 |
| 배포 정책 | 74 통과 | 73 통과·1 생략 |
| 소스 숨김 GUI | 86 통과·9 생략 | 88 통과·7 생략 |
| 최종 설치본 숨김 GUI | 86 통과·9 생략 | 88 통과·7 생략 |
| 소스·설치본 실제 데스크톱 | 각각 4 통과 | 각각 4 통과 |
| 설치 파일 검사 | DMG 무결성·읽기 전용 마운트·codesign 통과 | NSIS 현재 사용자 범위·`/allusers` 거절·페이로드 검사 통과 |
| 설치본 실행 | 실제 PTY·내장 helper·정상 종료 통과 | 실제 PTY·내장 helper·정상 종료 통과 |

단위 검사의 생략은 각 OS에 해당하지 않는 5개와 미선택 Docker·파일 부하 2개입니다. Windows 배포 정책의 1개 생략은 Windows에서 제외하는 산출물 symlink 경로 검사입니다. 숨김 GUI는 Mac에서 Windows 전용 6개, Windows에서 macOS 전용 4개와 각 OS의 미선택 Docker·지속 부하·대용량 텍스트 3개를 생략했습니다. Windows 내장 Bash·cmd·Windows PowerShell·PowerShell 7·DPAPI·드라이브 검사는 모두 통과했습니다.

소스와 최종 설치본의 숨김 수명 감사는 각각 Mac 시작·정상 종료·감사 37회, 앱 재사용 34회, 창 47개이며, Windows는 시작·정상 종료·감사 40회, 앱 재사용 37회, 창 49개입니다. 네 실행 모두 표시·네이티브 포커스 0회이며 정상 종료 제한을 충족했습니다.

## 공개 설치 파일

| 파일 | 크기(바이트) | SHA-256 |
| --- | ---: | --- |
| `Passport-1.3.3-mac-arm64.dmg` | 173,570,336 | `49c44e054accfe0e5c84238f0abc23e338d95bc38097602c358a113bbc503221` |
| `Passport-1.3.3-win-x64.exe` | 207,253,152 | `3ffdc0f93ac9ece516612c599cfae981b300cf77996e427514d725cae309fed3` |

두 설치 파일은 정식 검증한 바이트 그대로 함께 게시했습니다. Mac은 ad-hoc 서명이며 Developer ID·Apple 공증이 없고, Windows EXE는 `NotSigned`입니다. SHA256SUMS.txt는 두 설치 파일을 포함하며 188바이트, SHA-256은 `9b4f4f7ce16976f639d805edd0cddc6a4fa6bad66fe9d61d8c424f8d81c3ab8b`입니다.

## 확인 범위와 남은 제한

- [이슈 #8](https://github.com/poyal/passport/issues/8)의 국기·분해형 한글·ZWJ 재현은 터미널별 macOS zsh 호환 모드로 대응합니다. 기본값은 Unicode 11이며 모든 셸·TUI·복합 문자의 폭이 동일함을 보장하지 않습니다.
- [이슈 #9](https://github.com/poyal/passport/issues/9)의 친구 요청 수신자 CLI 송수신, 앱을 유지한 터미널 재연결과 프로파일 적용을 회귀 검사합니다. Codex 모의 실행으로 인수 전달·환경 상속을 확인하는 범위이며, 실제 Codex `resume` 내부 동작이나 최초 장애 원인을 확정한 것은 아닙니다.
- 쪽지 조회·승인·읽기의 사용자 허락은 AI 안내문에서 대화상 범위를 요구합니다. 앱이 대화상 허락을 독립적으로 검증하지는 않습니다. 친구 등록 승인은 앱에서만 처리합니다.
- 두 앱의 루프백·safeStorage 모의 검사는 실제 다른 PC의 LAN·Keychain 실기와 구분합니다. 이전 버전의 실기 결과를 이 버전의 결과로 간주하지 않습니다.
- 물리 IME·실제 AI 서비스·OS 알림·깨끗한 계정의 설치/제거/업그레이드·macOS 14 실기·Developer ID/Apple 공증은 별도 확인 대상입니다. Docker·장시간 부하 검사는 이번 정식 검증에 선택하지 않았습니다.
