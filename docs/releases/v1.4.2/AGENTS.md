# Passport 1.4.2 검증 기록

Mac ARM64와 Windows x64는 같은 커밋 `658b3746b57a6a66890a66fe896333b45adfa7e1`에서 빌드했습니다. [GitHub 릴리즈](https://github.com/poyal/passport/releases/tag/v1.4.2) · [사용자 매뉴얼](README.md)

## 설치·업데이트

Mac은 공개 1.4.1의 격리 복사본에서 서명된 1.4.2를 설치하고 새 버전을 다시 열어 호스트·설정과 키체인 자격 증명의 복원을 확인했습니다. 최종 DMG 안의 앱으로도 키체인 암호화와 복호화를 검사했습니다.

Windows는 공개 1.4.1 도우미의 설치 폴더 잠금 때문에 두 경로를 따로 검사했습니다. 첫 번째 검사는 원본 1.4.1을 설치 폴더 밖에서 실행해 공식 서명 패키지로 1.4.2를 설치했습니다. 두 번째 검사는 1.4.1 격리 복사본에 1.4.2 설치 파일에서 추출한 도우미를 넣고 시작 메뉴 바로가기와 같은 작업 디렉터리에서 같은 패키지를 적용했습니다. 두 검사 모두 정상 재실행, 호스트·설정 보존과 DPAPI 자격 증명 복원을 확인했습니다. 공개 1.4.0·1.4.1의 바로가기에서 처음 전환할 때에는 1.4.2 설치용 EXE를 사용합니다.

## 정식 검사

단위·배포 정책·GUI 열은 통과 / 생략 수입니다. 데스크톱 열은 소스 및 설치본의 실제 포커스·클립보드 검사 통과 수입니다.

| 플랫폼 | 단위·통합 | 배포 정책 | 소스 GUI | 설치본 GUI | 데스크톱 소스 / 설치본 |
| --- | --- | --- | --- | --- | --- |
| mac-arm64 | 338 / 9 | 89 / 0 | 113 / 11 | 113 / 11 | 4 / 4 |
| win-x64 | 337 / 10 | 88 / 1 | 114 / 10 | 114 / 10 | 4 / 4 |

- `20261128T032155Z-658b374-mac-arm64-local-release` · 27.2.0 · Node v24.21.0 · Electron 44.10.0
- `20261128T031844Z-658b374-win-x64-local-release` · 10.0.26300 · Node v26.13.0 · Electron 44.10.0

## 공개 파일

GitHub 최신 릴리즈를 인증 없이 조회하고 공개 파일 9개의 크기와 SHA-256을 대조했습니다. 각 플랫폼의 앱 내 업데이트 메타데이터는 기존 배포 공개 키로 Ed25519 서명을 확인했습니다. 확인 시각은 `2026-11-28T04:00:46.123Z`입니다.

| 파일 | 바이트 | SHA-256 |
| --- | ---: | --- |
| `Passport-1.4.2-darwin-arm64-update.zip` | 173763812 | `3bc3b40da4d59304f8f6a11cc02d910c00aa55017c8ecee3e80cc0e200623138` |
| `Passport-1.4.2-mac-arm64.dmg` | 174879564 | `53d9a6f90c0931e4e0a72b9bd43c7e6117808f446ed9f3157b0fbc05b0c54e7b` |
| `Passport-1.4.2-win-x64.exe` | 207419430 | `b357d4f499009ee98ee9e8836e757436a042cf07a32cbcc65aed86e09810bbe5` |
| `Passport-1.4.2-win32-x64-update.zip` | 365210748 | `22be8d8fb05198e96b1218c670491ae7d01cabd82847a9ba2e846aef3ee63f34` |
| `SHA256SUMS.txt` | 751 | `0ae6b905b7264593f2db77ddac2d656a33fa8e2c2d8383bb5964f132753db782` |
| `update-darwin-arm64.json` | 221 | `b8d98a9d36a6d45788148f8c39a09642bed8eb23b5c4b0f2d0b8a180da411e1b` |
| `update-darwin-arm64.sig` | 64 | `466e03b88e3247a612e0790123a30f6b1bb68e831fe79afcd6c14e1101efce28` |
| `update-win32-x64.json` | 215 | `526602206e0ca4a5bbda4685e985e78b38b89cdb803fe0cce64f1af187a0dcb2` |
| `update-win32-x64.sig` | 64 | `ab5c70c20c84136f898fbca6121160d89087c411b2314d7dc0d44d63c667d4c8` |

Mac DMG에는 ad-hoc 서명을 사용했습니다. Developer ID·공증, Windows Authenticode 게시자 서명, 최초 실행 시 Gatekeeper·SmartScreen 승인 화면, 물리 키보드 IME 및 최소 지원 OS 실기는 이번 검사 범위 밖입니다.
