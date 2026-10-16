# Windows 붙여넣기 검증 및 릴리즈 인계

## 1.3.0 Windows 후속 배포 인계 — 2026-10-16

사용자는 Mac만 먼저 게시하고 Windows는 집의 PC에서 진행하기로 했다. 현재 [1.3.0](https://github.com/poyal/passport/releases/tag/v1.3.0)에는 Mac DMG와 체크섬만 있다. Windows 최신 공개판은 1.2.3이며 이번 Mac에서 Windows 설치본을 만들거나 원격 Actions를 실행하지 않았다.

Windows 1.3.0은 **`v1.3.0` / `359e207a11006446d786ee55bab94d0f874fdc03`** 소스를 사용한다. 이후 `main`의 변경은 문서 정리이므로 빌드 소스와 혼동하지 않는다. 태그를 옮기거나 Mac 파일을 교체하지 않는다.

1. Windows 11 x64 PC에 아래 준비 절의 도구를 갖추고, 기존 작업 폴더가 깨끗한지 확인한다. 미커밋 작업이 있으면 별도 체크아웃을 사용한다.
2. 아래 명령으로 소스·최종 EXE를 검증한다. `--desktop`은 창·포커스·클립보드를 사용하는 검사이므로 사용자가 실행 가능한 시점에 수행한다.

```powershell
git fetch origin --tags
git switch --detach v1.3.0
git rev-parse HEAD
npm.cmd ci
npm.cmd run prepare:runtime -- x64
npm.cmd run release:verify -- --desktop
```

3. 공유의 실제 DPAPI 재시작 복구, Attachment Execution Services·Zone.Identifier, NTFS가 아닌 경로/보호 실패 처리, 내장 Git 실행·서명 신뢰, 두 PC의 등록·승인·취소·LAN 검증 결과를 [보안 검토 항목](security-review-20261016.md#공개-전-남은-검증)에 추가한다. 자동 시험의 모의 암호화를 실제 OS 검증으로 기록하지 않는다.
4. 같은 깨끗한 체크아웃에서 출력된 정식 검증 기록으로 게시 계획을 확인한다. 계획에 Windows EXE 추가와 체크섬 갱신만 있고 기존 Mac DMG가 보존되는지 확인한 뒤 게시한다. 실패·preview 기록은 일반 게시 도구에서 허용하지 않는다.

```powershell
npm.cmd run release:publish -- --manifest release/checks/<실행-ID>/verification.json
npm.cmd run release:publish -- --manifest release/checks/<실행-ID>/verification.json --execute
```

게시 후 공개 EXE 다운로드 해시, 합본 `SHA256SUMS.txt`, Mac DMG의 ID·크기·해시·갱신 시각 보존을 확인한다. README의 Windows 1.2.3 링크와 릴리즈 본문의 Mac 전용 안내를 갱신하고 결과 문서는 별도 커밋으로 남긴다. Mac 게시의 실기 연기 예외를 Windows 검사 통과로 해석하지 않는다.

아래 버전별 기록과 1.1.1 명령은 과거 이력이다. 1.3.0에서는 위 소스와 명령을 사용한다.

## 1.2.2 Windows 배포 완료 — 2026-10-12

Mac과 같은 `v1.2.2` 소스 `e399c2bcbf85dcedc69aa5eebddbfbe82200752c`로 Windows x64 EXE를 [공개 배포](https://github.com/poyal/passport/releases/tag/v1.2.2)했다. [격리된 Windows 검증](https://github.com/poyal/passport/actions/runs/38241471604)에서 만든 원본 설치본과 보고서를 내려받아 게시 도구로 재검사하고 재빌드 없이 게시했다. 기존 Mac DMG·태그와 직전 1.2.1 자산은 보존했다. [Windows 게시·검증 요약](benchmarks/github-release-windows-v1.2.2.json).

소스·최종 EXE 숨김 GUI는 각각 74개·74개 통과, 허용 생략은 각각 4개·4개다. 데스크톱 검사는 각각 4개·4개 통과했다. 파일 드롭·대상 패널 호버, 자기 패널 드롭 거절, 붙여넣기와의 입력 순서, 연결 변경 시 폐기, Shift+Enter 변경·해제·초기화와 기존 네 가지 셸·클립보드·DPAPI·NSIS 설치 범위를 확인했다. 탐색기의 물리 파일·폴더 드래그, 실제 CLI의 파일 해석·줄바꿈, 사용자 계정 설치·제거·업그레이드, 물리 IME·OS 알림·외부 AI 서비스는 별도 확인 대상이다. Windows 설치본은 코드 서명이 없다.

이번 실행은 [운영 가이드의 격리된 runner 절차](local-release-guide.md#actions-운영)를 사용했다.

```powershell
gh workflow run desktop.yml --repo poyal/passport --ref v1.2.2 -f target=win-x64
```

검증 결과의 `release/builds/<실행 ID>/`와 `release/checks/<실행 ID>/`를 상대 경로 그대로 같은 태그의 깨끗한 체크아웃에 내려받았다. `release:publish`의 게시 계획을 확인한 뒤 `--execute`로 게시했으며, 인증 없는 공개 EXE 다운로드 해시와 합본 체크섬도 일치했다. README의 Windows 1.2.1 고정 링크와 GitHub 릴리즈 본문을 갱신했다. 검증 소스·태그는 유지하고 게시 문서는 별도 커밋으로 기록한다.

이 PC에서는 창·포커스를 사용하는 검사와 사용자 설치본·DB 변경을 하지 않았다. 이후 제품 수정은 동일 소스 계약에 맞는 새 버전으로 진행한다.

## 1.2.1 Windows 배포 완료 — 2026-10-08

Mac과 같은 `v1.2.1` 소스(`7be5713`)로 Windows x64 EXE를 [공개 배포](https://github.com/poyal/passport/releases/tag/v1.2.1)했다. [격리된 Windows 검증](https://github.com/poyal/passport/actions/runs/37772353610)에서 만든 설치본과 원본 보고서를 Windows PC로 내려받아 게시 도구로 재검사하고 재빌드 없이 게시했다. 기존 Mac DMG·태그와 직전 1.2.0 자산은 보존했다. [Windows 게시·검증 요약](benchmarks/github-release-windows-v1.2.1.json).

소스·최종 설치본의 숨김 GUI는 각각 67개·67개 통과, 허용 생략은 각각 4개·4개다. 데스크톱 검사는 각각 4개·4개 통과했다. 기존 복수 단축키의 첫 키 유지, **키 변경·X·초기화**, Ctrl+V 붙여넣기, 네 가지 셸·DPAPI·NSIS 설치 범위를 확인했다. Ctrl+Shift+V는 직접 지정했을 때만 Passport 붙여넣기로 동작한다.

이번 실행은 [운영 가이드의 격리된 runner 절차](local-release-guide.md#actions-운영)를 사용했다.

```powershell
gh workflow run desktop.yml --repo poyal/passport --ref v1.2.1 -f target=win-x64
```

검증 결과의 `release/builds/<실행 ID>/`와 `release/checks/<실행 ID>/`를 상대 경로 그대로 같은 태그의 깨끗한 체크아웃에 내려받은 뒤, `release:publish -- --manifest <verification.json>`으로 계획을 확인하고 `--execute`로 게시했다. 공개 EXE 다운로드 해시·합본 체크섬을 확인하고 README의 Windows 1.2.0 고정 링크와 GitHub 릴리즈 본문을 갱신했다. 검증 소스와 태그는 유지하며 문서는 게시 후 별도 커밋으로 기록한다.

이 PC의 창·포커스를 사용하는 검사는 실행하지 않았다. 사용자 설치본·DB도 변경하지 않았다. 실제 사용자 계정 설치·업그레이드, 물리 IME, OS 알림·외부 AI 서비스는 별도 확인 대상이다. 이후 제품 수정은 동일 소스 계약에 맞는 새 버전으로 진행한다.

## 이전 Windows 1.1.1 기록

2026-10-03 Windows 11 x64에서 소스와 최종 EXE의 정식 로컬 검증을 통과하고 Windows 1.1.1을 공개했다. 사용자가 미게시 Windows 버전의 테스트 보정·버그픽스를 승인해 소스 태그 `v1.1.1-win-x64`를 사용했다. 기존 Mac `v1.1.1` 태그와 DMG는 유지했다. [게시 요약](benchmarks/github-release-windows-v1.1.1.json)에 출처·해시·범위를 기록했다. 실제 탐색기·AI 서비스·물리 IME·OS 알림·사용자 계정 업그레이드는 별도 확인 대상이다. 이후 릴리즈는 기본 버전·동일 소스 계약을 따른다.

## 준비와 자동 검사

[로컬 배포 운영 가이드](local-release-guide.md)의 Node 24 이상, npm, Rust/MSVC와 Spectre 완화 라이브러리, Python, OpenSSL, Windows PowerShell 5.1, PowerShell 7 준비 조건을 따른다. PowerShell에서는 인수가 npm 실행 파일에 그대로 전달되도록 `npm.cmd`를 사용한다. 내장 Bash 런타임은 해당 아키텍처로 준비한다. 아래는 Windows x64 명령이다.

```powershell
git fetch origin --tags
git switch --detach v1.1.1-win-x64
npm.cmd ci
npm.cmd run prepare:runtime -- x64
npm.cmd run release:check
npm.cmd run test:e2e -- tests/e2e/paste.spec.ts tests/e2e/windows-shells.spec.ts
```

붙여넣기 숨김 시험은 사용자 클립보드를 변경하지 않고 Electron API에 데이터를 주입한다. Windows 셸 시험은 Passport Bash·cmd·Windows PowerShell·PowerShell 7에서 한글·공백·작은따옴표·`&`가 포함된 경로를 붙인 뒤 실제 파일 내용을 읽는다. 셸 미설치로 생략된 결과는 정식 릴리즈 통과로 인정하지 않는다.

## 실제 탐색기·CLI 확인

테스트 창 하나를 재사용하고 다음 항목의 OS·셸·CLI 버전과 결과를 기록한다. 자동 시험만으로 탐색기의 실제 클립보드 형식이나 AI의 이미지 읽기 성공을 확인했다고 기록하지 않는다.

- 탐색기에서 파일 하나, 여러 파일, 폴더를 복사해 붙인다. 한글·공백 경로와 사용 가능한 UNC 공유 경로를 확인한다.
- 텍스트는 Ctrl+Shift+V와 Ctrl+V로 한 번만 입력되고 자동 실행되지 않아야 한다.
- 캡처 도구의 이미지를 붙이면 PNG가 저장되고 경로가 입력되어야 한다. 이미지 파일 복사와 이미지 픽셀 복사를 각각 확인한다.
- Claude Code·Codex에서 저장된 이미지 경로를 붙이고 내용을 읽도록 요청한다. Alt+V는 CLI에서 지원하는 경우 실제 첨부 표시까지 확인한다. 이 요청은 해당 AI 서비스 사용량을 소비할 수 있다.
- PowerShell의 작은따옴표 포함 경로와 Passport Bash의 Windows 경로를 확인한다. cmd의 `%`·`!` 경로는 잘못 입력되지 않고 오류가 표시되어야 한다.
- 연속 붙여넣기, 붙여넣기 직후 탭 전환·연결 종료, 다중 창, SSH 원격 업로드 안내를 확인한다.
- 사용자 지정 붙여넣기 단축키와 일반 셸의 Alt+V 입력이 의도대로 유지되는지 확인한다. Alt+V는 Passport가 이미지 첨부 성공을 보장하는 명령이 아니라 CLI로 전달하는 키다.

검증 자료는 `release/checks/<실행 ID>/`에 출처·커밋·플랫폼·상태와 함께 보관하고, 필요한 이미지는 개인정보 없는 테스트 자료를 사용한다.

## 정식 검증과 게시

모든 수정·버전·릴리즈 노트를 커밋한 깨끗한 작업 폴더에서 실행한다. 실제 포커스 검사는 작업을 방해할 수 있으므로 별도 데스크톱에서 진행한다.

```powershell
npm.cmd run release:verify -- --desktop
```

출력된 `verification.json` 경로를 아래 명령에 넣는다. 실패·미리보기 기록은 게시할 수 없다. 검증 이후 소스를 수정했다면 다시 검증한다. 이번 Windows 1.1.1은 검증 소스와 `v1.1.1-win-x64` 태그를 일치시킨다. 다른 릴리즈는 같은 커밋과 `v<버전>` 태그를 원격에 올리고, 이미 공개된 버전의 설치본을 바꿀 때는 새 버전을 사용한다.

```powershell
npm.cmd run release:publish -- --manifest release/checks/<실행-ID>/verification.json
npm.cmd run release:publish -- --manifest release/checks/<실행-ID>/verification.json --execute
```

첫 명령은 게시 계획 확인, 두 번째는 실제 게시다. GitHub 인증을 준비하고 다른 플랫폼과 동시 게시하지 않는다. 기존 플랫폼 산출물과 체크섬 보존 규칙은 [운영 가이드](local-release-guide.md)를 따른다.
