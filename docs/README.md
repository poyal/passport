# Passport 문서

설치와 기능 소개는 [제품 README](../README.md)에서 확인한다. 이 폴더에는 상세 사용법과 개발·설계·검증 기록을 보관한다.

## 사용자 안내

- [로컬 AI · SSH 작업 공간](local-ai-workspaces.md): 새 셸·프로파일·알림 사용법, 데이터 이행과 대상별 검증 범위.
- [사용 안내](user-guide.md): 호스트 연결, 탭·분할, 탭별 템플릿, 파일 전송, 스니펫, 외형, 백업과 문제 해결.
- [설치 안내](../README.md#설치): Mac DMG·Windows EXE 다운로드, 최초 실행 허용, 업데이트와 파일 무결성 확인.
- [릴리즈 노트](releases/README.md): 버전별 변경 사항·날짜·배포 상태와 설치 파일.

## 개발과 배포

| 문서                                                 | 내용                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| [개발 안내](development.md)                          | 환경 준비, 로컬 실행, 코드 구조, 데이터, 테스트 명령                    |
| [구현 구조](architecture.md)                         | 프로세스 권한, 세션 수명, 터미널 렌더링, 전송, 저장                     |
| [배포 안내](distribution.md)                         | 플랫폼별 패키징, 서명·공증 상태, 수동 CI, 배포 전 확인                  |
| [산출물 보관 규칙](distribution.md#산출물-보관-규칙) | `release/` 저장 위치, 보관 기간, 복구 백업과 정리 기준                  |
| [최신 검증 기록](verification.md)                    | 탭별 템플릿·스크롤·설정·업데이트·구형 SSH와 패키지 실행, 이전 성능 시험 |
| [스크린샷 안내](screenshots.md)                      | README 이미지의 예제 데이터와 재촬영 방법                               |

[로컬 검증 후 배포 운영 안내](local-release-guide.md): 다른 프로젝트에 적용할 구조와 Passport의 검증·게시 명령.

[Windows 붙여넣기 검증·릴리즈 인계](windows-paste-release.md): 집의 Windows PC에서 수행할 셸·탐색기·Claude/Codex 확인과 정식 게시 순서.

## 기획과 디자인

- [제품 전환과 신규 기능 계획](../plan.md): 로컬 AI·SSH 작업 화면, Windows·macOS 셸 선택과 시작 프로파일, Windows 내장 Bash, 프로젝트 실행·배치 저장, 작업 알림. 사전 검토와 후속 구현 선택·대상별 검증 조건을 함께 기록한다.
- [확정 계획](plan.md): 요구사항, 제외 범위, 디자인 원칙과 단계별 작업 계획. 승인 당시 계획과 후속 구현 상태를 함께 보존한다.
- [앱 아이콘](icons.md): 초기 5종 시안, 확정한 v2 아이콘, 생성 기록과 적용 상태.
- [앱 디자인 시안](../design/passport-design.png) · [SVG 원본](../design/passport-design.svg).
- [터미널 스타일 비교 시안](../design/terminal-styles.png) · [SVG 원본](../design/terminal-styles.svg).

정적 디자인 시안은 검토 당시 자료다. 현재 앱 모습은 [제품 README](../README.md)의 스크린샷을 기준으로 한다. 앱에서 참조하는 이미지 원본은 `design/`에 유지한다.

## 기록과 고지

- [v0.1 검증 기록](archive/verification-v0.1.md): 이전 버전 결과.
- [검증 원시 데이터](benchmarks/): 부하·Docker·패키지 실행 결과 JSON.
- [오픈소스 고지](../THIRD_PARTY_NOTICES.md): 설치본에도 포함하므로 저장소 루트에 유지한다.
