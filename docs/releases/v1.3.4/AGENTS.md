# Passport 1.3.4 AI 기록

이 문서는 1.3.4의 배포 소스·검증 환경·최종 결과·남은 제한을 기록합니다. 공통 작업 지침은 [루트 AGENTS](../../../AGENTS.md), 개발·E2E·문서 규칙은 [공통 개발 규칙](../../development.md), 검증·게시·정리 절차는 [릴리즈 가이드](../../release.md)를 따릅니다. 사용자 조작은 [1.3.4 매뉴얼](README.md)에서 확인합니다.

## 버전별 데이터와 화면 기준

SQLite 스키마는 7, 문서·portable 형식은 2입니다. 기존 DB는 `before-v7-<시각>.sqlite`로 백업한 뒤 세션 복원·로그 묶음 테이블을 추가합니다. 갱신된 DB를 1.3.3에서 열 수 없습니다. 복원 정보는 일반 내보내기·자동 백업·템플릿에서 제외하며 AI 실행 옵션은 OS 보안 저장소로 암호화합니다.

매뉴얼 전체 화면은 1.3.1 최종 Mac 앱에서, 앱 내부 쪽지 가이드의 두 부분 화면은 1.3.1 Windows UI에서 격리된 예제 데이터로 촬영했습니다. 변경되지 않은 화면을 재사용하며 1.3.4에서 새로 촬영한 화면으로 표시하지 않습니다.

## 검증과 공개 상태

2026-10-20에 [v1.3.4](https://github.com/poyal/passport/releases/tag/v1.3.4)를 **Mac ARM64를 먼저 공개**했습니다. Windows 추가 게시 결과는 아래 별도 절에 기록합니다. 설치 파일의 소스와 태그는 `3b54357fe6a34432ead722a40fb38bc2ca50e10f`입니다. 게시 결과는 `published-and-download-verified`이며 DMG와 `SHA256SUMS.txt`의 공개 다운로드·해시를 확인했습니다. 이 최종 기록을 반영하는 후속 문서 커밋은 배포 바이너리의 소스 커밋과 구분합니다. 사용자 설치본은 교체하지 않았습니다.

당시 Windows 1.3.4는 검증·빌드·게시하지 않았습니다. 당시 Windows 공개 설치본은 [v1.3.3](https://github.com/poyal/passport/releases/tag/v1.3.3)을 유지하며 기존 EXE의 크기·SHA-256이 바뀌지 않았음을 확인했습니다.

## Mac 정식 검증 환경과 결과

사용자가 Mac 실제 데스크톱 검사를 허용한 뒤 깨끗한 위 커밋에서 `PASSPORT_NATIVE_AI=1 npm run release:verify -- --desktop`을 수행했습니다. 최종 manifest는 `preview: false`, `status: verified`이며 소스·설치본 GUI 실패·재시도·flaky는 없습니다.

| 환경 | Mac |
| --- | --- |
| OS·아키텍처 | macOS 27.0.1(26A434), arm64 · Darwin 27.0.0 |
| Node.js·npm | 25.6.0 · 11.8.0 |
| Rust Cargo·Electron | 1.99.1 · 44.8.0 |
| Python·OpenSSL | 3.12.11 · 3.6.2 |
| Xcode Command Line Tools | 27.0.0.0.1788430756 |
| 실제 AI CLI | Codex 0.163.0 · Claude Code 2.1.304 |

Node·npm·Python·OpenSSL·Command Line Tools·AI CLI는 설치된 도구를 사용했습니다. Rust 1.99.1은 공식 rustup으로 작업 전용 경로에 설치했고, GitHub CLI 2.102.0은 공식 ARM64 배포 ZIP의 SHA-256을 확인해 게시에 사용했습니다. 시스템 PATH와 사용자 Rust 설정을 변경하지 않았습니다.

| 검사 | Mac 결과 |
| --- | --- |
| 잠금 의존성·FTP/FTPS fixture·타입·빌드 | 통과 |
| 단위·통합 | 272 통과·7 생략 |
| 배포 정책 | 75 통과 |
| 소스 숨김 GUI | 95 통과·9 생략 |
| 최종 DMG 내부 앱 숨김 GUI | 95 통과·9 생략 |
| 소스·설치본 실제 데스크톱 | 각각 4 통과 |
| 설치 파일 검사 | DMG 무결성·읽기 전용 마운트·codesign 통과 |
| 설치본 실행 | 실제 PTY·내장 helper·정상 종료 통과 |

단위 검사의 생략은 Windows 전용 5개와 미선택 Docker·파일 부하 2개입니다. 숨김 GUI의 생략은 Windows 전용 6개와 미선택 Docker·지속 부하·대용량 텍스트 3개입니다. 실제 AI CLI 검사는 선택해 소스·설치본에서 모두 수행했으며 생략하지 않았습니다.

소스와 최종 설치본의 숨김 수명 감사는 각각 시작·정상 종료·감사 46회, 창 56개, 앱 재사용 37회입니다. 두 실행 모두 표시·네이티브 포커스 0회이며 정상 종료 제한을 충족했습니다. 실제 데스크톱 검사는 각각 앱 4개가 정상 종료했습니다.

실제 Codex·Claude CLI에서 앱 완전 종료·재시작 전후의 동일 대화 ID, 다음 메시지, 기본 Codex 실행과 명시한 승인·샌드박스 옵션, 빈 Claude 세션 재실행을 확인했습니다. Electron의 HOME·USERPROFILE을 유지한 정상 OS safeStorage를 사용했으며, CLI 설정·대화 저장 폴더와 모델 응답은 격리했습니다. 모델 응답만 루프백 fixture이므로 실제 유료 서비스·로그인 검증과 구분합니다.

## 공개 설치 파일

| 파일 | 크기(바이트) | SHA-256 |
| --- | ---: | --- |
| `Passport-1.3.4-mac-arm64.dmg` | 173,619,402 | `5cf5b866356be339fd2df9458268af7a61b27d73848046b05f8d3798b5d95967` |
| `Passport-1.3.4-win-x64.exe` | 207,286,945 | `6ca7ba9555242737a0d6e57f68f773e75313ee3bc7c4fe2c8b12f78b3675cd1f` |
| `SHA256SUMS.txt` | 188 | `3a070c8d5c15b78ed9a892be615d32f35f103116af1f4b09b3a5163d5ccd99aa` |

DMG는 정식 검증한 바이트 그대로 게시했습니다. Mac은 ad-hoc 서명이며 Developer ID·Apple 공증을 포함하지 않습니다. 현재 합본 체크섬 파일에는 위 Mac DMG와 Windows EXE가 모두 포함됩니다. GitHub의 자동 Source code 링크는 별도 설치 파일이 아닙니다.

## 확인 범위와 남은 제한

2026-10-20 Windows 추가 배포를 위해 원래 `v1.3.4` 소스 `3b54357fe6a34432ead722a40fb38bc2ca50e10f`에서 의존성·runtime·빌드를 준비했습니다. `scroll-workspaces.spec.ts`의 로그 화면 검사에서 Windows 11의 최소 창 크기일 때 로그 내용 높이가 0이 되는 결함을 재현했습니다. 따라서 Windows 1.3.4 정식 검증·게시를 완료하지 않았습니다. 사용자는 이 구버전의 추가 수정을 보류하고 Windows 1.3.5 게시를 완료하도록 선택했습니다. 같은 결함의 수정은 별도 Windows 1.3.5 후보에 포함했으며, 이를 1.3.4가 검증되었다는 근거로 사용하지 않습니다.

- 이전 세션 복원은 전역 설정이며 기본 꺼짐입니다. 등록 SSH의 출력·Bash/zsh 작업 폴더와 로컬 Codex·Claude 대화를 구분합니다. 원격 AI·일반 프로세스·tmux는 복원 대상이 아닙니다.
- Codex 훅 신뢰는 CLI 자체의 검토 절차를 따릅니다. 훅 ID가 없거나 옵션·저장된 대화를 확인할 수 없으면 다른 최근 대화를 추정하지 않고 셸과 사유를 표시합니다.
- 로그 묶음은 기존 파일·북마크를 유지하면서 연결별 구간을 연결합니다. 복원 화면을 새 로그에 중복 저장하지 않으며 AI가 실제 재출력한 과거 내용은 live 출력으로 기록합니다.
- [이슈 #10](https://github.com/poyal/passport/issues/10)의 터미널 메뉴는 친구 선택 즉시 전송을 요청하는 **바로 보내기**와 초안을 여는 **쪽지로 작성**을 구분합니다. 작성 중인 본문·첨부는 버리기·취소 확인으로 보호합니다.
- 실제 Codex·Claude 검사에서 모델 응답은 루프백 fixture이며, 유료 API·실제 서비스 로그인·대화 서비스의 정상 동작 검증과 구분합니다.
- 다른 PC의 LAN·물리 IME·OS 알림·깨끗한 계정의 설치/제거/업그레이드·macOS 14 실기·Developer ID/Apple 공증·Docker·장시간 부하는 별도 확인 대상입니다.

## Windows 정식 검증과 추가 게시

2026-10-21 사용자 요청으로 [v1.3.4](https://github.com/poyal/passport/releases/tag/v1.3.4)에 Windows x64 설치본을 추가했습니다. Windows 소스는 `v1.3.4-win-x64` 태그의 `23d7d193b1721f9184d329d1e5398bb5917b1845`입니다. 원본 Mac 태그·DMG의 자산 ID·크기·SHA-256은 유지했으며, 후속 main 문서 커밋은 바이너리 소스와 구분합니다.

실제 데스크톱 검사를 승인받고 깨끗한 Windows 후보에서 `npm run release:verify -- --desktop`을 수행했습니다. 최종 실행은 `20261021T114946Z-23d7d19-win-x64-local-release`, 상태는 `verified`, `preview: false`입니다. 이전 실패·부분 진단을 최종 정식 실행의 성공으로 합산하지 않았습니다.

환경은 Windows 11 x64(10.0.26300), Node 24.14.0, npm 11.21.1, Rust 1.99.1, Electron 44.8.0, Python 3.13.7, OpenSSL 3.5.7, Visual Studio Build Tools 2022, PowerShell 7.6.6입니다. 작업 전용 Rust·GitHub CLI는 저장소의 임시 도구 경로를 사용했고 시스템 PATH·사용자 Rust 설정은 변경하지 않았습니다.

| 검사 | Windows 결과 |
| --- | --- |
| 잠금 의존성·FTP/FTPS·타입·빌드·내장 runtime | 통과 |
| 단위·통합 | 269 통과·10 생략 |
| 배포 정책 | 79 통과·1 생략 |
| 소스 숨김 GUI | 96 통과·8 생략 |
| 최종 EXE 내부 앱 숨김 GUI | 96 통과·8 생략 |
| 소스 / 최종 EXE 내부 앱 실제 데스크톱 | 각각 4 / 4 통과 |
| NSIS·설치본 실행 | 현재 사용자 범위·`/allusers` 거절·실제 PTY·helper·정상 종료 통과 |

단위 생략은 다른 OS용 8개와 미선택 Docker·파일 부하 2개입니다. 게시 정책의 1개는 Windows에서 정책상 생략하는 artifact 심볼릭 링크 사례입니다. 숨김 GUI 생략은 Mac 전용 4개와 미선택 Docker·지속 부하·대용량 텍스트·설치된 실제 AI CLI 4개입니다. Windows DPAPI 저장·재시작, 네 종류의 Windows 셸, 드라이브 탐색·다운로드 보호는 실행했습니다. 설치된 실제 AI CLI·실제 유료 AI 서비스 검증과 모의 CLI 검사를 구분합니다.

| 숨김 수명 감사 | 시작 / 정상 종료 / 감사 | 창 | 앱 재사용 | 표시 / 네이티브 포커스 |
| --- | --- | --- | --- | --- |
| 소스 | 47 / 47 / 47 | 56 | 40 | 0 / 0 |
| 최종 EXE 내부 앱 | 47 / 47 / 47 | 56 | 40 | 0 / 0 |

실제 데스크톱은 소스·설치본에서 각각 앱 4개가 정상 종료했습니다. 최종 정식 GUI의 실패·재시도·flaky는 0입니다. OS 알림 표시는 모의 어댑터로 검사했으며 실제 네이티브 포커스·격리 클립보드 검사를 포함합니다.

게시 결과는 `published-and-download-verified`입니다. 인증 없는 공개 URL에서 EXE와 `SHA256SUMS.txt`를 다시 다운로드해 크기·SHA-256·원본 Mac 체크섬 보존을 확인했습니다. Windows EXE는 Authenticode 서명이 없습니다. 사용자 설치 앱·실제 DB는 교체하지 않았습니다.

깨끗한 계정의 실제 설치·제거·업그레이드, 물리 IME, 실제 OS 알림 표시, 다른 PC의 LAN/VPN, 실제 유료 AI 서비스, Docker·장시간 부하는 별도 확인 대상입니다.

검증 재개 시 최소 창 크기의 로그 본문 높이, 화면 재로드 뒤 빈 터미널이 저장된 이력을 덮어쓰는 문제를 확인했습니다. 1.3.5의 해당 수정을 원본 1.3.4에 필요한 범위만 반영했습니다. 모의 AI의 입력 리스너 설치·새 PID 준비 신호를 기다리도록 복원 시험도 수정했습니다. 관련 로그 화면 6개, 이력·AI 재개·완전 재시작 3개와 데스크톱 4개의 진단 통과 후 위 단일 정식 실행을 완료했습니다.
