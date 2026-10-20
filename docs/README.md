# Passport 문서 안내

사용법은 저장소의 대표 문서인 [Passport 사용자 매뉴얼](../README.md)에서 확인합니다. 이 폴더에는 다음 개발과 릴리즈를 실제로 수행하는 데 필요한 가이드와 버전별 최종 문서를 보관합니다.

| 하려는 작업 | 읽을 문서 |
| --- | --- |
| 설치·사용·백업·업데이트 | [사용자 매뉴얼](../README.md) |
| 공통 개발 규칙·환경 준비·플랫폼 계약·검사·E2E 작성 | [공통 개발 규칙](development.md) |
| 버전 준비·검증·태그·GitHub 게시·실패 후 재개·정리 | [릴리즈 가이드](release.md) |
| AI 작업의 기본 지침 | [루트 AGENTS](../AGENTS.md) |
| 현재 Mac·Windows 공개 버전의 검증 결과·남은 제한 | [1.3.5 AI 기록 — Mac ARM64·Windows x64 공개](releases/v1.3.5/AGENTS.md) |
| 현재 공개 버전 사용자 매뉴얼 | [1.3.5 사용자 문서](releases/v1.3.5/README.md) |
| 이전 Mac 버전 | [1.3.4 AI 기록](releases/v1.3.4/AGENTS.md) · [1.3.4 사용자 문서](releases/v1.3.4/README.md) |
| 이전 Mac·Windows 버전 | [1.3.3 AI 기록](releases/v1.3.3/AGENTS.md) · [1.3.3 사용자 문서](releases/v1.3.3/README.md) |
| 이전 버전 문서 | [1.3.2 AI 기록](releases/v1.3.2/AGENTS.md) · [1.3.2 사용자 문서](releases/v1.3.2/README.md) |
| Windows 추가 게시를 보류한 구버전 | [1.3.0 AI 기록](releases/v1.3.0/AGENTS.md) · [사용자 문서](releases/v1.3.0/README.md), [1.0.1 AI 기록](releases/v1.0.1/AGENTS.md) · [사용자 문서](releases/v1.0.1/README.md) |
| Windows 설치본을 추가한 초기 버전 | [1.0.0 AI 기록](releases/v1.0.0/AGENTS.md) · [1.0.0 사용자 문서](releases/v1.0.0/README.md) |

2026-10-20 Windows 누락 설치본 중 1.0.0·1.3.2를 원래 공개 소스로 추가하고, 사용자가 요청한 1.3.5 수정본은 별도 Windows 소스 태그로 구분했습니다. 1.0.1·1.3.0·1.3.4는 원본 Windows 검증 실패 후 사용자 선택에 따라 추가 배포를 보류했습니다. 버전별 소스와 검증 범위는 각 AI 기록에 남깁니다.

**“docs를 읽고 릴리즈”할 때는 릴리즈 가이드의 준비부터 공개 다운로드 확인까지 순서대로 진행합니다.** 환경 준비는 개발 가이드를, 이미 공개한 버전의 소스·검증 범위는 해당 버전의 AI 문서를 함께 확인합니다. 현재 `main`과 공개 태그가 같은 소스라고 가정하지 않습니다.

공통 개발 규칙과 릴리즈 절차는 현재 소스에 맞춰 한 곳에서 유지합니다. 버전마다 `docs/releases/v<버전>/`에는 사람이 보는 `README.md`와 AI가 보는 `AGENTS.md` 두 개를 보관하며 이전 버전 폴더도 유지합니다. 버전 AI 문서에는 해당 버전의 사실·결과·제한만 기록하고 공통 규칙을 복제하지 않습니다. 패치 노트는 [GitHub Releases](https://github.com/poyal/passport/releases)에만 씁니다.

완료한 계획·일지·중간 보고서·생성물은 삭제합니다. 재사용할 절차·규칙·확정 결과는 해당 문서에 반영하며, 문서 수를 줄이기 위해 필요한 작업 안내를 지우거나 링크만 남기지 않습니다. 자세한 기준은 [문서 관리 규칙](development.md#사용자-매뉴얼과-문서-관리)을 따릅니다.
