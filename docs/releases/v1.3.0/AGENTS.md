# Passport 1.3.0 AI 기록

원본 공개 태그 `v1.3.0`의 소스는 `359e207a11006446d786ee55bab94d0f874fdc03`입니다. [사용자 매뉴얼](README.md)과 [공통 릴리즈 절차](../../release.md)를 참고하세요.

2026-10-20 Windows 누락 설치본을 확인하며 Windows 11 x64, Node 24.14.0, npm 11.21.1, Electron 44.8.0, Rust 1.99.1, Python 3.13.7, MSVC Build Tools 2022에서 원본 태그의 의존성·내장 runtime·빌드를 준비했습니다.

사전 GUI 검사 중 `sharing.spec.ts`의 첫 앱이 `Failed to get 'downloads' path`로 시작하지 못했습니다. 이 태그의 시험은 HOME·USERPROFILE을 임시 폴더로 지정하지만 Windows Downloads 폴더를 준비하지 않습니다. 진단 실행에서 창 0개·앱 종료를 확인했으며 이 결과를 쪽지 전송 기능의 검증 성공 또는 기능 자체의 결함으로 해석하지 않습니다. 전체 정식 검증·최종 설치 파일 검증을 완료하지 않았습니다.

사용자는 2026-10-20 이 구버전의 추가 수정을 보류하고 Windows 1.3.5 게시를 완료하도록 선택했습니다. 따라서 Windows 1.3.0 설치 파일을 게시하지 않았고 기존 공개 태그·Mac 파일을 유지했습니다. 당시에는 격리 Windows 프로필 준비 수정과 남은 전체 시험 확인이 필요했습니다. 이후 버전의 Windows 수정이 원본 태그에 포함되어 있다고 가정하지 않습니다.

## Windows 정식 검증과 추가 게시

2026-10-21 사용자 요청으로 [v1.3.0](https://github.com/poyal/passport/releases/tag/v1.3.0)에 Windows x64 설치본을 추가했습니다. Windows 소스는 `v1.3.0-win-x64` 태그의 `70614754c1f6375eba10a401c7b57a40eb4c0154`입니다. 원본 Mac 태그·DMG의 자산 ID·크기·SHA-256은 유지했으며, 후속 main 문서 커밋은 바이너리 소스와 구분합니다.

실제 데스크톱 검사를 승인받고 깨끗한 Windows 후보에서 `npm run release:verify -- --desktop`을 수행했습니다. 최종 실행은 `20261021T120829Z-7061475-win-x64-local-release`, 상태는 `verified`, `preview: false`입니다. 이전 실패·부분 진단을 최종 정식 실행의 성공으로 합산하지 않았습니다.

환경은 Windows 11 x64(10.0.26300), Node 24.14.0, npm 11.21.1, Rust 1.99.1, Electron 44.8.0, Python 3.13.7, OpenSSL 3.5.7, Visual Studio Build Tools 2022, PowerShell 7.6.6입니다. 작업 전용 Rust·GitHub CLI는 저장소의 임시 도구 경로를 사용했고 시스템 PATH·사용자 Rust 설정은 변경하지 않았습니다.

| 검사 | Windows 결과 |
| --- | --- |
| 잠금 의존성·FTP/FTPS·타입·빌드·내장 runtime | 통과 |
| 단위·통합 | 224 통과·7 생략 |
| 배포 정책 | 77 통과·1 생략 |
| 소스 숨김 GUI | 85 통과·5 생략 |
| 최종 EXE 내부 앱 숨김 GUI | 85 통과·5 생략 |
| 소스 / 최종 EXE 내부 앱 실제 데스크톱 | 각각 4 / 4 통과 |
| NSIS·설치본 실행 | 현재 사용자 범위·`/allusers` 거절·실제 PTY·helper·정상 종료 통과 |

단위 생략은 다른 OS용 5개와 미선택 Docker·파일 부하 2개입니다. 게시 정책의 1개는 Windows에서 정책상 생략하는 artifact 심볼릭 링크 사례입니다. 숨김 GUI 생략은 Mac 전용 2개와 미선택 Docker·지속 부하·대용량 텍스트 3개입니다. Windows DPAPI 저장·재시작, 네 종류의 Windows 셸, 드라이브 탐색·다운로드 보호는 실행했습니다. 설치된 실제 AI CLI·실제 유료 AI 서비스 검증과 모의 CLI 검사를 구분합니다.

| 숨김 수명 감사 | 시작 / 정상 종료 / 감사 | 창 | 앱 재사용 | 표시 / 네이티브 포커스 |
| --- | --- | --- | --- | --- |
| 소스 | 37 / 37 / 37 | 46 | 35 | 0 / 0 |
| 최종 EXE 내부 앱 | 37 / 37 / 37 | 46 | 35 | 0 / 0 |

실제 데스크톱은 소스·설치본에서 각각 앱 4개가 정상 종료했습니다. 최종 정식 GUI의 실패·재시도·flaky는 0입니다. OS 알림 표시는 모의 어댑터로 검사했으며 실제 네이티브 포커스·격리 클립보드 검사를 포함합니다.

게시 결과는 `published-and-download-verified`입니다. 인증 없는 공개 URL에서 EXE와 `SHA256SUMS.txt`를 다시 다운로드해 크기·SHA-256·원본 Mac 체크섬 보존을 확인했습니다. Windows EXE는 Authenticode 서명이 없습니다. 사용자 설치 앱·실제 DB는 교체하지 않았습니다.

깨끗한 계정의 실제 설치·제거·업그레이드, 물리 IME, 실제 OS 알림 표시, 다른 PC의 LAN/VPN, 실제 유료 AI 서비스, Docker·장시간 부하는 별도 확인 대상입니다.

원본 시험의 격리 프로필에 Downloads가 없어 공유·CLI 앱이 시작하지 못하던 문제, 시작 경로·연결 복구 시험의 오래된 기본 셸 지정, Claude 완료 이벤트의 잘못된 기대값을 후속 버전과 동일하게 보완했습니다. 실제 첨부 보호에서는 Windows PowerShell 5.1의 .NET 파일 API가 Zone.Identifier 스트림을 거부하는 문제를 재현했습니다. 파일시스템 provider의 `Set-Content`·`Get-Content -Stream`으로 변경하고 IAttachmentExecute·ZoneId 3·내용 보존·리터럴 파일명·없는 파일 거절 검사를 유지했습니다.

숨김 사전 검사 한 번은 로컬 프롬프트 대기에서 실패했으나 같은 소스의 단독 진단과 다음 전체 순서에서는 통과했습니다. 그 실패의 정확한 원인은 확정하지 못했으며, 게시에는 최종 소스·설치본 전체 검사를 모두 통과한 위 실행만 사용했습니다.

## 공개 설치 파일

| 파일 | 크기(바이트) | SHA-256 |
| --- | ---: | --- |
| `Passport-1.3.0-mac-arm64.dmg` | 170,831,382 | `baa2e5374025b6f288331a8dcab798f8e32256a2460f35b78c1f0ec181d98fb9` |
| `Passport-1.3.0-win-x64.exe` | 205,999,859 | `2fefcc25736f10679ebce6e3ddf8a03ce1e3acfa18fe98e2d4e668e779fa5e41` |
| `SHA256SUMS.txt` | 188 | `349cb4be2c641ac9e49039b8e2ad5fd71c0c4f46c62929e37c980a7e85c8a58b` |
