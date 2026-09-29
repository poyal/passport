# 오픈소스 고지

Passport의 프로젝트 라이선스를 별도로 부여하는 문서가 아닙니다. 포함된 오픈소스 구성요소는 각 저작권자와 라이선스 조건을 따릅니다. 빌드 시 `dist/licenses/`에 실제 설치 버전의 의존성 목록과 제공된 라이선스 원문을 모읍니다. Electron과 Chromium의 고지는 패키저가 설치본에 포함합니다.

## 글꼴

JetBrains Mono: Copyright JetBrains s.r.o., SIL Open Font License 1.1. 앱에 400/700 굵기를 포함하며, 글꼴 이름을 변경하지 않습니다. 원문은 `@fontsource/jetbrains-mono` 패키지의 LICENSE와 함께 배포합니다.

## 터미널 팔레트

다음 프로젝트의 색상 값을 터미널 배경·전경·ANSI 16색·커서에 대응시켰습니다. 선택 영역은 전경색에 Passport가 투명도를 추가한 값이며, 기본 블랙은 자체 프리셋입니다. 256색·트루컬러 처리와 원격 ANSI 해석은 xterm.js를 사용합니다.

| 테마 | 저작자 / 프로젝트 | 라이선스 · 출처 |
| --- | --- | --- |
| Catppuccin Mocha / Latte | Catppuccin contributors | MIT · https://github.com/catppuccin/catppuccin |
| One Dark | GitHub / Atom contributors | MIT · https://github.com/atom/one-dark-syntax |
| Dracula | Zeno Rocha and contributors | MIT · https://github.com/dracula/terminal-app |
| Tokyo Night | Folke Lemaitre and contributors | Apache-2.0 · https://github.com/folke/tokyonight.nvim |
| Nord | Arctic Ice Studio / Sven Greb | MIT · https://github.com/nordtheme/nord |
| Gruvbox Dark / Light | Pavel Pertsev | MIT · https://github.com/morhetz/gruvbox |
| Solarized Dark / Light | Ethan Schoonover | MIT · https://ethanschoonover.com/solarized/ |
| Campbell | Microsoft Corporation | MIT · https://github.com/microsoft/terminal |

애플리케이션 브랜드, 아이콘, 기능 및 화면은 해당 프로젝트가 Passport를 보증한다는 의미가 아닙니다.

## 운영체제 아이콘

Alpine Linux, CentOS, Red Hat, Rocky Linux, Ubuntu, Debian, Fedora, Linux, Apple 로고는 [Simple Icons](https://github.com/simple-icons/simple-icons/tree/d4e6ba93e48f178898707f0145ec285f28b64b38)에서 가져왔습니다. SVG 경로는 원본 그대로이며 앱에서는 흰색 로고와 색상 타일로 표시합니다. 브랜드의 권리와 상표는 각 소유자에게 있습니다. Windows 타일은 네 개의 사각형으로 그립니다.

- Simple Icons 구성물: CC0-1.0.
- Debian Open Use 로고: Software in the Public Interest, Inc., [CC BY-SA 3.0](https://www.debian.org/logos/).
- Rocky Linux 로고: Rocky Linux / Rocky Enterprise Software Foundation, [CC BY-SA 4.0](https://github.com/rocky-linux/branding).
- Fedora 로고: Fedora Project / Red Hat, Inc., [Fedora 브랜드 안내](https://docs.fedoraproject.org/en-US/project/brand/).

원본 출처, 개별 라이선스 정보와 고지는 `licenses/os-icons/` 및 설치본의 `dist/licenses/os-icons/`에 포함합니다.
