<p align="center">
  <img src="design/icons/04-passport-terminal-v2.png" width="112" alt="Passport 앱 아이콘" />
</p>

<h1 align="center">Passport</h1>

<p align="center">
  <strong>내 컴퓨터의 AI 작업과 서버 터미널을 한 화면에서.</strong><br />
  로컬 터미널·Claude Code·Codex·SSH와 파일 전송을 하나의 데스크톱 앱에서.
</p>

<p align="center">
  <a href="https://github.com/poyal/passport/releases/latest">다운로드</a> ·
  <a href="#설치">설치</a> ·
  <a href="#주요-기능">주요 기능</a> ·
  <a href="#시작하기">시작하기</a> ·
  <a href="docs/user-guide.md">사용 안내</a>
</p>

로컬 AI 작업과 SSH 접속, 분할 터미널, 서버 간 파일 복사를 한 화면에서 처리합니다. 호스트를 그룹과 태그로 정리하고, 자주 사용하는 터미널 구성을 템플릿으로 저장해 다시 열 수 있습니다.

![Passport에서 로컬 개발 터미널과 SSH 두 개를 함께 배치한 작업 화면](docs/assets/workspace.png)

<p align="center"><sub>실제 앱 화면입니다. 서버·파일·터미널 출력은 촬영용 예제 데이터입니다.</sub></p>

## 설치

| 환경                                   | 다운로드                                                                                            | 버전      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- | --------- |
| **Mac · Apple Silicon**, macOS 14 이상 | [DMG 받기](https://github.com/poyal/passport/releases/download/v1.1.1/Passport-1.1.1-mac-arm64.dmg) | **1.1.1** |
| **Windows 11 · Intel / AMD(x64)**      | [EXE 받기](https://github.com/poyal/passport/releases/download/v1.1.0/Passport-1.1.0-win-x64.exe)   | **1.1.0** |
| Windows · ARM64                        | 별도 실기 검증 후 배포                                                                              | 준비 중   |

Windows 1.1.1은 Windows PC에서 검증 후 별도로 배포합니다. Intel Mac은 지원하지 않습니다. [버전별 변경 사항](docs/releases/README.md).

- **Mac:** DMG를 열고 Passport를 **응용 프로그램** 폴더로 옮긴 뒤 설치 디스크를 추출하세요. 업데이트할 때는 기존 앱을 **⌘Q로 완전히 종료**하고 새 앱으로 대치합니다.
- **Windows:** EXE를 실행해 설치 폴더를 선택하세요. 현재 로그인한 사용자에게 설치하며 관리자 권한을 요청하지 않습니다. 업데이트할 때는 Passport를 종료한 뒤 새 설치 프로그램을 실행합니다.

현재 Mac 설치본은 ad-hoc 서명이며 Apple 공증을 포함하지 않습니다. 공식 릴리즈에서 받은 앱의 실행이 차단되면 **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**에서 허용하세요. [Apple 안내](https://support.apple.com/ko-kr/102445). Windows EXE에도 코드 서명이 없습니다.

앱은 시작 시 새 버전을 확인하며 **설정 → About**에서도 확인할 수 있습니다. 설치 파일은 브라우저로 다운로드하며 앱 내부 자동 설치는 제공하지 않습니다. 호스트·설정·작업 배치는 앱과 별도로 보관하므로 업데이트 후에도 유지됩니다.

<details>
<summary>다운로드 파일의 SHA-256 확인</summary>

설치 파일과 **같은 버전의 릴리즈**에서 `SHA256SUMS.txt`를 받으세요. 아래 결과를 해당 설치 파일의 체크섬과 비교합니다.

Mac 터미널:

```sh
cd ~/Downloads
shasum -a 256 Passport-1.1.1-mac-arm64.dmg
cat SHA256SUMS.txt
```

Windows PowerShell:

```powershell
cd ~/Downloads
Get-FileHash .\Passport-1.1.0-win-x64.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

</details>

## 주요 기능

| 기능                   | 할 수 있는 일                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- |
| **호스트 관리**        | 그룹·태그·즐겨찾기, 검색·일괄 편집, 자동 OS 아이콘과 수동 아이콘 선택               |
| **SSH 접속**           | 비밀번호·개인 키 인증, 호스트 키 확인, 구형 서버의 키 교환 자동 호환                |
| **로컬 AI · SSH 작업** | 로컬·SSH 혼합 분할, Claude·Codex 실행, 프로젝트 폴더, 별도 창 이동                  |
| **시작 프로파일**      | Windows 내장 Passport Bash·cmd·PowerShell, macOS 셸, 여러 프로파일과 적용 순서 선택 |
| **AI 작업 알림**       | 알림에서 원래 터미널로 이동, 보고 있는 터미널만 읽음 처리, 알림 기록 보관           |
| **템플릿**             | 탭 하나의 로컬·SSH 구성과 분할 비율을 저장하고 바로 실행                            |
| **파일 전송**          | 로컬·SFTP·FTP·명시적 FTPS, 업로드·다운로드·서버 간 복사와 전송 취소                 |
| **작업 도구**          | 명령어 스니펫, 터미널 검색, 로컬 터미널, 로컬·원격·SOCKS 포트 포워딩                |
| **외형 설정**          | 라이트·다크, 테마 12종과 사용자 테마, 설치 글꼴 검색·내장 글꼴 7종·커서·파일 색상   |
| **터미널 붙여넣기**    | 파일·폴더·앱의 전체 경로, 여러 파일, 이미지 PNG 저장, 원래 터미널에 순서대로 입력   |
| **기록과 백업**        | 세션 로그, 최대 30일 자동 로그 보관, 설정 내보내기·가져오기                         |

<details>
<summary>호스트·파일 전송·외형 화면 보기</summary>

**호스트 관리:** 이름·주소·계정·태그로 검색하고 그룹에 공통 설정을 지정합니다. 호스트를 두 번 클릭하면 연결합니다.

![그룹과 태그로 정리한 호스트 목록](docs/assets/hosts.png)

**파일 전송:** 좌우 패널에서 로컬 컴퓨터나 서버를 선택하고 드래그하거나 작업 메뉴로 복사합니다.

![SFTP 파일 목록과 작업 메뉴](docs/assets/files.png)

**외형:** 앱과 터미널 테마를 따로 선택하고 글꼴·커서·파일 색상을 조절합니다.

![터미널 외형과 테마 설정](docs/assets/appearance.png)

</details>

## 시작하기

1. 왼쪽 **+** 또는 시작 화면의 **로컬 터미널**을 누르세요. 홈 폴더에서 터미널이 바로 열립니다. `cd`로 작업 폴더로 이동하고, 설치된 `claude` 또는 `codex`를 실행합니다.
2. **설정 → 로컬 터미널**에서 기본 셸과 시작 프로파일을 선택하세요. Windows는 Git Bash 설치 없이 **Passport Bash**를 사용할 수 있고, **cmd·Windows PowerShell·PowerShell 7**도 선택할 수 있습니다. Mac은 기본 로그인 셸·zsh·bash를 지원합니다.
3. **호스트 → 새 호스트**에서 서버를 등록하고 두 번 클릭해 연결하세요. 로컬 패널의 **터미널 분할**로 SSH를 옆에 추가할 수 있습니다. 첫 연결은 서버 관리자가 제공한 SSH 지문과 비교해 승인합니다.
4. 원하는 탭을 연 뒤 작업 영역 오른쪽 위의 **저장 아이콘(템플릿 저장)**을 누르세요. 그 탭과 내부 분할만 저장됩니다. **템플릿** 화면에서 카드를 누르면 같은 구성으로 새 탭을 열고 연결합니다.
5. AI 알림은 **설정 → 로컬 터미널**에서 **AI 작업 알림** 프로파일을 선택하고 Claude/Codex 연동을 켜세요. 새 터미널부터 적용됩니다. 벨 버튼에서 알림함을 확인하고, **설정 → AI 작업 알림**에서 OS 배너 조건과 테스트 알림을 확인합니다.

### 터미널 단축키와 붙여넣기

| 동작                         | Mac | Windows                  |
| ---------------------------- | --- | ------------------------ |
| 현재 창에 새 로컬 터미널     | ⌘N  | Ctrl+N                   |
| 새 Passport 창과 로컬 터미널 | ⌘⇧N | Ctrl+Shift+N             |
| 터미널에 붙여넣기            | ⌘V  | Ctrl+Shift+V 또는 Ctrl+V |

Finder·탐색기에서 파일이나 폴더를 복사하면 **전체 경로**를 입력합니다. Mac의 `.app`도 지원하며 공백·한글·여러 경로는 셸에 맞게 처리합니다. 캡처한 이미지 픽셀은 PNG 파일로 저장해 경로를 붙입니다. Enter를 자동으로 입력하지 않습니다. SSH에서는 파일 전송으로 업로드한 뒤 원격 경로를 사용하세요.

Claude Code·Codex 자체의 이미지 붙여넣기 키를 사용할 때는 Mac **Ctrl+V**, Windows **Alt+V**를 해당 CLI에 전달합니다. 실제 첨부 동작은 CLI의 지원 범위에 따릅니다.

활성 창에서 해당 터미널을 보면 그 터미널의 미읽음 표시를 지우고 알림 기록은 유지합니다. 새 창을 열어도 기존 터미널 연결은 유지됩니다. 단축키는 설정에서 변경할 수 있습니다.

**설정 → 외형 → 터미널 설정**에서 설치된 글꼴과 내장 글꼴을 검색하고 한글·표 미리보기로 선택하세요. JetBrains Mono, Cascadia Mono/Code, Fira Code, Source Code Pro, IBM Plex Mono, D2Coding을 포함합니다.

자세한 셸·프로파일·템플릿·알림 설정은 [로컬 AI 작업 안내](docs/local-ai-workspaces.md), 연결·검색·로그·파일 전송은 [사용 안내](docs/user-guide.md)를 확인하세요.

## 설정과 작업 배치 보관

열린 탭과 분할 배치는 자동 저장되며 앱을 다시 열면 복원합니다. 저장한 템플릿도 유지됩니다. 앱 재시작 때 서버에 자동으로 연결하지 않으므로 필요한 연결을 직접 시작하세요.

**설정 → 내보내기와 백업**에서 호스트·그룹·스니펫·템플릿·작업 배치·설정을 파일로 내보내고 다른 컴퓨터에서 가져올 수 있습니다. 비밀번호와 개인 키는 기본적으로 제외하며 포함할 때는 **10자 이상의 별도 암호**로 보호합니다. 암호는 파일에 저장하지 않으므로 따로 보관하세요. 암호화된 파일을 가져올 때만 암호 입력창을 표시합니다.

## 문서와 개발

- [사용 안내](docs/user-guide.md): 연결·파일 전송·설정·문제 해결.
- [릴리즈 노트](docs/releases/README.md): 버전별 변경 사항과 배포 상태.
- [개발 안내](docs/development.md): 소스 실행·빌드·테스트.
- [검증 기록](docs/verification.md): Windows·Mac 테스트 결과와 성능 측정 범위.
- [로컬 검증 후 배포](docs/local-release-guide.md): 로컬에서 검증한 설치 파일을 그대로 GitHub Release에 게시.
- [Windows 검증·릴리즈 인계](docs/windows-paste-release.md): Windows 실기 확인과 게시 순서.
- [배포 안내](docs/distribution.md): 패키징·서명·산출물 보관.
- [전체 문서](docs/README.md) · [오픈소스 고지](THIRD_PARTY_NOTICES.md).

---

제작자 **Poyal** · [poyal.work@gmail.com](mailto:poyal.work@gmail.com) · [GitHub](https://github.com/poyal/passport) · [버그 신고·기능 제안](https://github.com/poyal/passport/issues)
