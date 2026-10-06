# Passport 릴리즈 노트

[제품 소개·설치](../../README.md) · [최신 공개 릴리즈와 설치 파일](https://github.com/poyal/passport/releases/latest) · [검증 기록](../verification.md)

버전별 변경 사항과 날짜는 이 목록과 각 릴리즈 문서에 기록합니다. 제품 README는 소개·설치·사용법을 유지합니다. 플랫폼별 최신 공개 버전이 다르면 다운로드 링크와 상태를 구분합니다.

| 버전               | 날짜       | 상태                                                                                       | 주요 변경                                                                       |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [1.2.0](v1.2.0.md) | 2026-10-07 | [Mac·Windows x64 공개 배포](https://github.com/poyal/passport/releases/tag/v1.2.0) | OS별 단축키, 터미널 링크, 설정 스크롤, 파일 복사·Windows 종료 정리 |
| [1.1.1](v1.1.1.md) | 2026-10-02 | [Mac·Windows x64 공개 배포](https://github.com/poyal/passport/releases/tag/v1.1.1), Windows 아이콘 수정본 10-03 교체 | 파일·이미지 붙여넣기, 터미널별 읽음, 새 창 단축키, 폰트 확장, 로컬 검증 후 배포, Windows 작업표시줄 아이콘 수정 |
| [1.1.0](v1.1.0.md) | 2026-10-01 | [Mac·Windows x64 공개 배포](https://github.com/poyal/passport/releases/tag/v1.1.0)         | 로컬 AI·SSH 작업 공간, 셸·시작 프로파일·알림, 탭별 템플릿                       |
| [1.0.2](v1.0.2.md) | 2026-09-30 | [Mac·Windows x64 공개 배포](https://github.com/poyal/passport/releases/tag/v1.0.2)         | Windows 현재 사용자 전용 설치·보호 파일·PTY 수정, 스페이스 저장·복원            |
| [1.0.1](v1.0.1.md) | 2026-09-30 | [공개 배포](https://github.com/poyal/passport/releases/tag/v1.0.1)                         | 업데이트 확인, About, 가져오기·내보내기·로그·검색·설정 개선                     |
| [1.0.0](v1.0.0.md) | 2026-09-30 | [공개 배포](https://github.com/poyal/passport/releases/tag/v1.0.0)                         | 첫 정식 릴리즈, 구형 SSH 호환, OS 아이콘, 터미널 파일 색상                      |

## 새 버전을 기록할 때

1. `docs/releases/v<버전>.md`에 주요 변경, 업데이트 방법과 알려진 제한을 기록합니다.
2. 이 목록에 버전·날짜·배포 상태를 추가합니다. 준비 중인 버전은 공개 설치 파일과 구분합니다.
3. 검증 결과는 [검증 기록](../verification.md)에 저장합니다.
4. 공개 게시 후 목록의 상태와 해당 릴리즈 링크를 갱신합니다.

로컬 게시 명령은 해당 버전의 Markdown을 GitHub Release 본문으로 사용합니다. 같은 플랫폼 구성을 유지하는 배포는 최신 릴리즈 링크를 재사용합니다. 설치 방법·기능·플랫폼별 공개 상태가 바뀌면 README를 갱신합니다.
