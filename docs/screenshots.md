# README 스크린샷

[전체 문서](README.md) · [제품 README](../README.md)

README의 이미지는 실제 Passport 1.1.0 화면을 촬영한 PNG다. 생성형 이미지나 초기 디자인 시안이 아니다. 촬영용 호스트·그룹·스니펫, 파일과 터미널 출력은 예제 데이터이며 실제 서비스 운영 상태를 나타내지 않는다.

| 파일                                            | 화면                                |
| ----------------------------------------------- | ----------------------------------- |
| [workspace.png](assets/workspace.png)           | 로컬 셸 + SSH 두 개의 혼합 작업 탭  |
| [templates.png](assets/templates.png)           | 탭 하나씩 저장하고 여는 템플릿 목록 |
| [local-settings.png](assets/local-settings.png) | 기본 셸·시작 프로파일·AI 알림 연동  |
| [hosts.png](assets/hosts.png)                   | 그룹·태그·즐겨찾기와 호스트 설정    |
| [files.png](assets/files.png)                   | 양쪽 SFTP 파일 탐색과 우클릭 메뉴   |
| [appearance.png](assets/appearance.png)         | 터미널과 외형 설정 패널             |
| [settings.png](assets/settings.png)             | 설정의 외형 하위 탭과 테마 목록     |
| [about.png](assets/about.png)                   | 제작자·연락처·업데이트 확인         |

## 다시 촬영하기

개발 환경과 데스크톱 세션을 준비하고 다음을 실행한다.

```sh
npm run build
npm run docs:screenshots
```

촬영 스크립트는 매번 임시 데이터 폴더와 루프백 SSH/SFTP fixture를 만든다. 문서용 예제 프로필만 저장하며 사용자의 기본 프로필·서버·인증 정보는 사용하지 않는다. 호스트 지문 확인은 이 촬영용 로컬 서버에 한해 자동 응답한다. 촬영용 공통 인증 카드에는 fixture 계정만 넣고 safeStorage를 임시 대역으로 바꿔 사용자 키체인에 접근하지 않는다. OS 아이콘 예시는 수동 선택으로 구성한다. Mac에서 로컬 zsh의 시작 파일도 임시 폴더에 구성하고 예제 출력은 임시 텍스트 파일을 `cat`으로 읽어 보낸다. 화면의 프로젝트와 CLI 안내는 촬영용 설명이며 실제 AI 응답을 나타내지 않는다. SSH 예제 출력은 fixture가 SSH 채널로 전송하며 색상 없는 긴 파일 목록에 앱의 파일 종류 강조를 적용한다. 파일 탐색의 목록은 실제 임시 파일에서 읽는다. 앱 UI와 렌더링 코드는 변경하지 않는다.

이미지를 `docs/assets/`에 저장하고 앱의 정상 종료를 확인한 뒤 서버와 임시 프로필을 정리한다. 촬영 후 개인 경로나 비밀정보, 알림·툴팁·깨진 배치가 들어가지 않았는지 이미지를 직접 확인한다. 촬영용 데이터나 화면 구성을 바꾸면 이 문서와 README 설명도 맞춘다.

아이콘은 [확정 원본](../design/icons/04-passport-terminal-v2.png)을 README에서 직접 참조한다. 시안과 승인 기록은 [아이콘 문서](icons.md)에 보관한다.
