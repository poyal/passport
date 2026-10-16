# 로컬 터미널 CLI 사용법

[사용자 매뉴얼](../README.md#terminal-cli) · [로컬 AI 안내](local-ai-workspaces.md)

Passport 안에서 실행한 스크립트·AI 도구가 같은 앱의 다른 로컬 패널에 입력하고 화면을 읽을 수 있습니다. Mac·Windows 1.2.3부터 제공하며 두 OS의 명령 형식은 같습니다. [플랫폼별 배포 상태](releases/README.md)를 확인하세요.

## 켜기와 내 패널 확인

1. **설정 → 로컬 터미널 → CLI 접근**을 엽니다.
2. **조회만** 또는 **조회·입력**을 선택합니다. 선택 즉시 저장되며 기본은 **끔**입니다.
3. 새 로컬 터미널을 열어 `passport --help`, `passport identify`를 실행합니다. ID와 탭 이름이 나오면 준비된 것입니다.

설정 변경은 기존 CLI 접근 권한을 즉시 폐기합니다. 셸이 켜진 채로 있어도 그 셸의 이전 자격은 다시 살아나지 않으므로 새 터미널을 열거나 재연결하세요. AI 작업 알림 설정·시작 프로파일과는 독립적입니다. 별도 CLI 설치나 시스템 PATH 변경은 필요하지 않습니다.

`passport identify --json`의 `value.paneId`가 명령을 실행한 **내 패널 ID**입니다. Bash·zsh에서는 `$PASSPORT_PANE_ID`, PowerShell에서는 `$env:PASSPORT_PANE_ID`로도 같은 ID를 확인할 수 있습니다. 이 환경 변수는 패널을 식별하며 현재 권한 유효 여부는 `identify`로 확인합니다.

## 명령

| 명령 | 결과 |
| --- | --- |
| `passport list` | 모든 창의 로컬 패널 ID·탭 이름·연결 상태·셸·시작 폴더·설정된 AI 도구 |
| `passport identify` | 호출한 패널 ID와 소속 탭 이름 |
| `passport read --pane ID --lines 20` | 해당 패널의 최근 화면 텍스트 |
| `passport send --pane ID "내용"` | 현재 입력 위치에 텍스트 추가 |
| `passport send --pane ID --file request.txt` | UTF-8 파일의 텍스트 추가 |
| `passport send --pane ID --file -` | 표준입력에서 받은 UTF-8 텍스트 추가 |
| `passport send --pane ID "내용" --submit` | 텍스트와 Enter를 같은 요청으로 전달 |
| `passport key --pane ID enter` | 키 한 번 전달 |

`key`는 `enter`, `esc`, `tab`, `backspace`, `ctrl-c`, `ctrl-d`를 지원합니다. 프로그램에서의 의미는 해당 프로그램의 키 처리에 따릅니다. 모든 명령에 `--help`, `--json`을 붙일 수 있고 `--help`·`--version`은 앱 연결 없이도 동작합니다.

대상은 명시해야 합니다. 현재 포커스가 있는 터미널로 자동 전송하지 않습니다. `--tab "정확한 이름"`도 사용할 수 있지만 이름이 같은 탭이 둘 이상이거나 그 탭에 로컬 패널이 여러 개 있으면 오류가 납니다. 이때 `passport list`에서 패널 ID를 선택하세요. 창을 옮겨도 패널 ID는 유지되며 이동 중 요청은 거절됩니다.

목록의 `launchCwd`는 **시작 폴더**입니다. 셸에서 `cd`한 현재 폴더를 추적하지 않습니다. `configuredAgent`는 설정된 Claude/Codex이며 현재 실행 중인 프로그램이나 작업 완료 상태를 뜻하지 않습니다.

## Bash·zsh 예제

아래 ID를 `passport list`에 나온 실제 대상 ID로 바꿉니다.

```sh
target_pane='대상-패널-ID'
passport identify
passport list --json
passport send --pane "$target_pane" '변경 내용을 검토해 주세요.'
passport key --pane "$target_pane" enter
passport read --pane "$target_pane" --lines 20

# 파일의 마지막 줄바꿈도 보존하며, Enter는 --submit으로 명시합니다.
passport send --pane "$target_pane" --file request.txt --submit
printf '%s' '추가로 테스트 결과를 확인해 주세요.' | passport send --pane "$target_pane" --file -
```

## PowerShell 예제

```powershell
$targetPaneId = '대상-패널-ID'
$myPaneId = (passport identify --json | ConvertFrom-Json).value.paneId
passport send --pane $targetPaneId '변경 내용을 검토해 주세요.'
passport key --pane $targetPaneId enter
passport read --pane $targetPaneId --lines 20

# PowerShell 버전에 따른 파이프 인코딩 차이를 피하려면 UTF-8 파일을 사용합니다.
$requestText = "변경 내용을 검토해 주세요.`n테스트 결과도 알려 주세요."
[IO.File]::WriteAllText((Join-Path $PWD 'request.txt'), $requestText, [Text.UTF8Encoding]::new($false))
passport send --pane $targetPaneId --file request.txt --submit
```

전송은 이미 작성된 입력 뒤에 내용을 추가합니다. `{{변수}}` 치환, 자동 인용, 기존 입력 삭제를 하지 않습니다. 셸 자체의 따옴표 해석은 전송 전에 적용되므로 `$` 등을 문자 그대로 보내려면 작은따옴표나 파일을 사용하세요. `-`로 시작하는 직접 입력은 `passport send --pane ID -- "--문자 그대로"`처럼 구분합니다.

입력은 UTF-8 기준 256 KiB까지입니다. 여러 줄·탭과 끝 줄바꿈을 보존하며 줄바꿈은 터미널 입력 형식으로 통일합니다. 여러 줄·탭은 대상 프로그램이 bracketed paste를 켰을 때만 보냅니다. ESC·NUL 등 다른 제어 문자는 텍스트로 보낼 수 없습니다. `--submit`도 이 검사를 우회하지 않습니다.

## 화면 읽기와 JSON

`read`는 현재 활성 버퍼에 남아 있는 화면과 이전 출력에서 최근 100줄을 기본으로 읽습니다. `--lines`는 1~1,000이며 응답 텍스트는 UTF-8 1 MiB로 제한됩니다. 자동 줄바꿈을 합치고 행 끝의 화면 채움 공백과 마지막 빈 행을 제외합니다. 색상·제어 시퀀스는 반환하지 않습니다.

TUI가 별도 화면을 사용하면 `buffer`는 `alternate`이며 그 화면만 읽습니다. 비활성 탭과 다른 창에서도 읽을 수 있고, 연결이 끊겨도 패널에 남은 화면은 읽을 수 있습니다. 패널을 없애거나 앱을 종료한 뒤의 기록은 이 명령으로 복원하지 않습니다. 세션 로그와는 별개이며 읽기를 위해 별도의 로그 파일을 만들지 않습니다.

`--json`은 성공과 실패 모두 stdout에 한 개의 JSON을 출력합니다.

```json
{"version":1,"ok":true,"value":{"paneId":"패널-ID","sessionId":"세션-ID","text":"검토 결과","buffer":"normal","truncated":false}}
```

`list`의 `value`는 배열이고 `identify`는 해당 패널 객체입니다. 패널 객체에는 `paneId`, `workspaceId`, `workspaceName`, `windowId`, `sessionId`, `status`, `shell`, `launchCwd`, `configuredAgent`, `moving`이 있습니다. 연결 전에는 `sessionId`가 `null`일 수 있으며 재연결하면 바뀝니다. 읽기 범위·크기 때문에 앞부분을 생략하면 `truncated: true`입니다.

성공 종료 코드는 `0`, 실행 오류는 `1`, 명령 인자 오류는 `2`입니다. JSON 실패는 `{"version":1,"ok":false,"error":{"code":"오류 코드","message":"설명"}}` 형태입니다. 일반 출력에서는 오류와 잘림 안내를 stderr에 보냅니다.

## 권한과 오류 해결

| 상황 | 확인할 내용 |
| --- | --- |
| `UNAUTHORIZED` | 설정을 확인하고 새 Passport 로컬 터미널에서 실행하세요. 권한 변경·재연결·종료 전 자격은 폐기됩니다. |
| `READ_ONLY` | 입력하려면 **조회·입력**으로 바꾸고 새 터미널을 여세요. |
| `AMBIGUOUS_TARGET` | `passport list`에서 고유한 패널 ID를 선택하세요. |
| `NOT_FOUND` | 패널이 남아 있는지 확인하세요. SSH 패널은 대상이 아닙니다. |
| `PASTE_UNSUPPORTED` | 대상 프로그램의 여러 줄 붙여넣기 지원을 확인하거나 줄바꿈·탭 없는 한 줄을 보내세요. |
| `CONTROL_CHARACTER` | 텍스트에서 제어 문자를 제거하고 필요한 키는 `passport key`로 보내세요. |
| `MOVING`, `NOT_READY` | 창 이동이나 화면 초기화가 완료된 후 다시 확인하세요. |
| `SESSION_CHANGED`, `DISCONNECTED` | 재연결·창 이동·종료 여부와 대상 ID를 다시 확인하세요. |
| `CANCELLED` | 요청 기한 또는 실행 중 권한·세션 변경을 확인하세요. |
| `UNAVAILABLE` | 앱이 실행 중인지 확인하고 새 로컬 터미널을 여세요. |
| `DELIVERY_UNKNOWN` | 응답을 받지 못했어도 입력은 전달됐을 수 있습니다. 자동 재전송하지 말고 화면을 읽어 확인하세요. |

요청 처리 제한은 5초이고 CLI는 통신 정리까지 최대 6초 기다립니다. 입력 성공은 PTY 쓰기를 수락했다는 뜻입니다. 프로그램이 그 입력을 처리했거나 AI 작업이 완료됐다는 뜻은 아닙니다.

접근 자격은 Passport가 새 로컬 터미널에 넘긴 환경 변수로 상속되며 그 자식 프로그램도 사용합니다. 자격을 복사한 같은 사용자 프로세스까지 구별하는 프로세스 격리 기능은 아닙니다. `PASSPORT_CONTROL_TOKEN` 값을 로그·스크립트 파일·다른 터미널에 복사하지 마세요. CLI는 토큰을 출력하거나 설정·DB에 저장하지 않습니다. 원격 TCP 서버는 열지 않습니다.

여기서 로컬은 Passport의 로컬 패널을 뜻합니다. 그 안에서 직접 실행한 `ssh`, WSL, TUI에도 해당 패널의 입력이 전달됩니다. 별도로 등록한 SSH 연결 패널은 목록·읽기·입력에서 제외합니다.

## 등록한 사용자에게 공유하기

`passport share friends/send/status/cancel`은 **설정 → 공유**에서 별도로 켭니다. 터미널 조회·입력 권한을 켤 필요가 없으며, 상대 등록과 매번 수신 승인은 앱 화면에서 처리합니다. **새 로컬 터미널**에서 먼저 `passport share friends --json`으로 친구의 별칭(`name`)·기기 ID(`id`)·차단 여부(`blocked`)를 확인하세요. 기존 `peers`도 같은 목록입니다. 정확한 별칭 또는 기기 ID를 `send --to`에 지정하고 반환된 ID로 `status`를 조회합니다. 전체 절차와 예시는 [공유 CLI 사용법](sharing.md#ai와-cli-사용)을 확인하세요.
