# Windows 붙여넣기 검증 및 릴리즈 인계

2026-10-02. Windows 실기 검증과 릴리즈는 사용자가 Windows PC에서 수행한다. Mac 결과를 Windows 통과 기록으로 사용하지 않는다. Mac 1.1.1과 같은 소스로 Windows 설치본을 만들려면 `v1.1.1` 태그를 체크아웃한다. 이후 문서 전용 커밋이 추가된 `main`과 릴리즈 태그를 혼동하지 않는다. Windows 코드를 추가 수정해야 한다면 기존 태그를 옮기지 않고 새 버전을 사용한다.

## 준비와 자동 검사

[로컬 배포 운영 가이드](local-release-guide.md)의 Node 24 이상, npm, Rust/MSVC, Python, OpenSSL, Windows PowerShell 5.1, PowerShell 7 준비 조건을 따른다. 내장 Bash 런타임은 해당 아키텍처로 준비한다. 아래는 Windows x64 예시이며 ARM64 PC에서는 `x64`를 `arm64`로 바꾼다.

```powershell
git fetch origin --tags
git switch --detach v1.1.1
npm ci
npm run prepare:runtime -- x64
npm run release:check
npm run test:e2e -- tests/e2e/paste.spec.ts tests/e2e/windows-shells.spec.ts
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
npm run release:verify -- --desktop
```

출력된 `verification.json` 경로를 아래 명령에 넣는다. 실패·미리보기 기록은 게시할 수 없다. 검증 이후 소스를 수정했다면 다시 검증한다. 같은 커밋과 `v<버전>` 태그를 원격에 올리고, 이미 공개된 버전의 설치본을 바꿀 때는 새 버전을 사용한다.

```powershell
npm run release:publish -- --manifest release/checks/<실행-ID>/verification.json
npm run release:publish -- --manifest release/checks/<실행-ID>/verification.json --execute
```

첫 명령은 게시 계획 확인, 두 번째는 실제 게시다. GitHub 인증을 준비하고 다른 플랫폼과 동시 게시하지 않는다. 기존 플랫폼 산출물과 체크섬 보존 규칙은 [운영 가이드](local-release-guide.md)를 따른다.
