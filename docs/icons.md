# Passport 앱 아이콘

- 작성일: 2026-09-29
- 상태: 사용자 최종 디자인 승인 완료(2026-09-29). 앱 화면·Mac 설치본·Windows 1.1.1 아이콘 수정본에 적용 및 검증 완료(2026-10-03).
- 확정 원본: [04-passport-terminal-v2.png](../design/icons/04-passport-terminal-v2.png).
- 생성 방식: 내장 `image_gen` 도구로 시안별 1회씩 생성.
- 파일: 투명 배경을 포함한 1254×1254 RGBA PNG 초기 5개와 후속 조합 시안 1개. 생성 원본을 수정하지 않고 프로젝트로 복사.
- 생성 프롬프트: [prompts.json](../design/icons/prompts.json)에 시안별 전체 원문과 옵션을 기록.

| 번호 | 이름              | 방향                                            | 파일                                          |
| ---- | ----------------- | ----------------------------------------------- | --------------------------------------------- |
| 1    | 터미널 게이트     | `>_` 프롬프트로 SSH 터미널 기능을 직접 표현     | [PNG](../design/icons/01-terminal-gate.png)   |
| 2    | 연결된 P          | Passport의 P를 연결된 띠 형태로 표현, 민트 바탕 | [PNG](../design/icons/02-linked-p.png)        |
| 3    | 분할 워크스페이스 | 왼쪽 위·아래와 오른쪽의 비대칭 3분할            | [PNG](../design/icons/03-split-workspace.png) |
| 4    | 패스포트 북       | 책자 표지에 터미널 기호를 결합                  | [PNG](../design/icons/04-passport-book.png)   |
| 5    | 트랜스퍼 링크     | 마주 보는 두 연결부로 원격 접속·전송 표현       | [PNG](../design/icons/05-transfer-link.png)   |

## 확정 디자인: 4번 책자 + 1번 터미널 심벌 v2

사용자 제안에 따라 4번의 책자·민트 책등·밝은 바깥 타일을 유지하고 표지의 `>`를 1번의 `>_` 심벌로 바꿨다.
내장 `image_gen` 편집 기능을 사용했으며 기존 1~5번 원본은 유지한다.

- [확정 아이콘 PNG](../design/icons/04-passport-terminal-v2.png)
- [편집 프롬프트·참조 이미지 기록](../design/icons/04-passport-terminal-v2.prompt.json)
- 승인: 사용자가 2026-09-29 “이걸로 확정”이라고 최종 앱 아이콘을 선택했다. 이후 승인된 구현 계획에 따라 앱에 적용했다.

![4번 책자와 1번 터미널 심벌 조합](../design/icons/04-passport-terminal-v2.png)

## 초기 5종 비교

| 1. 터미널 게이트                                          | 2. 연결된 P                                     | 3. 분할 워크스페이스                                            | 4. 패스포트 북                                          | 5. 트랜스퍼 링크                                          |
| --------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| ![1. 터미널 게이트](../design/icons/01-terminal-gate.png) | ![2. 연결된 P](../design/icons/02-linked-p.png) | ![3. 분할 워크스페이스](../design/icons/03-split-workspace.png) | ![4. 패스포트 북](../design/icons/04-passport-book.png) | ![5. 트랜스퍼 링크](../design/icons/05-transfer-link.png) |

## 디자인 판단

- 1번은 터미널 기능을 즉시 전달하는 방향이다.
- 2번은 앱 이름을 기억할 수 있는 P 모노그램 중심이다. 초기 5종에서의 추천안이며, 최종 선택은 4번+1번 조합 v2다.
- 3번은 다중 SSH 분할이라는 앱의 핵심 조작을 표현한다.
- 4번은 Passport라는 이름과 터미널 기능을 함께 담는다.
- 5번은 접속과 파일 전송을 추상적인 연결 심벌로 표현한다.

확정 원본은 v2 PNG다. [빌드 스크립트](../scripts/build.mjs)가 이 파일을 `build/icon.png`로 복사하며 앱 화면과 Mac 패키징에 사용한다. Windows 빌드는 같은 원본에서 `build/icon.ico`를 생성한다. 실행 파일·NSIS 바로가기와 실행 중인 창이 같은 ICO를 사용하며, 창에서는 ASAR 밖의 `resources/icon.ico`를 읽는다. 원본 크기의 PNG를 Windows 창 아이콘으로 전달하지 않는다.

Windows 회귀 검사는 실제 HWND의 `WM_GETICON`에서 큰 아이콘과 작은 아이콘을 읽고, 같은 크기로 로드한 Passport ICO와 픽셀 해시를 대조한다. 새 창·작업 공간 이동 창을 포함해 소스와 최종 설치본에서 실행한다. 아이콘 원본 디자인은 변경하지 않는다. [Electron의 Windows ICO 안내](https://www.electronjs.org/docs/latest/api/native-image).

Windows 창은 처음 표시하기 전에 `setAppDetails`로 기존 앱 ID, ICO 경로, 재실행 명령과 Passport 이름을 지정한다. 작업표시줄 그룹 아이콘은 창 아이콘과 별도로 실제 화면에서도 확인한다. 같은 앱 ID의 오래된 Electron 개발용 바로가기는 잘못된 그룹 아이콘을 만들 수 있다. 알림 정책 E2E는 격리 DB에서만 노출되는 알림 어댑터를 대체하여 네이티브 `isSupported()`·생성자의 시작 메뉴/COM 등록을 실행하지 않는다. [Windows 작업표시줄 그룹 아이콘 속성](https://learn.microsoft.com/en-us/windows/win32/properties/props-system-appusermodel-relaunchiconresource).

원본 이미지와 생성 프롬프트는 앱에서 참조하는 `design/icons/`에 보관한다. 문서용 실제 앱 화면은 [스크린샷 안내](screenshots.md)를 참고한다.

## 서버 운영체제 아이콘

0.3.1은 앱 아이콘과 별도로 서버 OS용 SVG 로고를 사용한다. Alpine은 파랑, CentOS는 노랑, Red Hat은 빨강, Rocky는 초록, Ubuntu는 주황으로 구분한다. Debian·Fedora·Linux·macOS·Windows도 제공한다. 호스트 목록·파일 패널·연결 선택 창에서 같은 컴포넌트를 사용하며 감지 실패는 공통 서버 아이콘으로 표시한다.

[SVG 자산](../src/renderer/assets/os/) · [출처와 고지](../licenses/os-icons/SOURCE.md) · [오픈소스 고지](../THIRD_PARTY_NOTICES.md#운영체제-아이콘).
