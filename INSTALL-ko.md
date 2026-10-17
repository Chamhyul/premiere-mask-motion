# Mask Motion 베타 설치 안내

## 요구 사항

- Adobe Premiere 26.0 이상
- Adobe Creative Cloud Desktop
- UXP Developer Tool 및 Developer Mode 불필요

같은 CCX를 Apple Silicon 맥·인텔 맥·Windows x64에 사용합니다. Apple Silicon 맥에서 핵심 측정·적용을 확인했으며, 인텔 맥·Windows와 설치형 CCX의 설치·재실행은 베타 테스트 대상입니다.

## 설치

1. [베타 릴리스](https://github.com/Chamhyul/premiere-mask-motion/releases/tag/v0.3.2-beta.1)의 Assets에서 **Mask-Motion-0.3.2-beta.1.ccx**를 받습니다.
2. 파일을 더블클릭하고 Creative Cloud Desktop에서 설치합니다.
3. Premiere의 **창(Window) → UXP Plugins → Mask Motion**을 엽니다. 설치 후 목록이 갱신되지 않았다면 Premiere를 재실행합니다.

GitHub가 자동 제공하는 **Source code (zip/tar.gz)는 설치 파일이 아닙니다.** CCX를 받으세요.

## 사용

복사한 프로젝트에서 먼저 테스트하세요.

1. 원본 비디오 클립의 **불투명도(Opacity)에 마스크**를 만들고 Premiere에서 추적을 완료합니다.
2. 원본 클립 하나를 선택하고 **클립 전체 측정**을 누릅니다.
3. 측정 후 원본 마스크를 비활성화합니다. 움직일 텍스트·그래픽 등의 대상을 원하는 시작 위치에 배치하고 선택합니다.
4. **선택한 대상에 적용**을 누릅니다. 새 변형 효과의 Position에 키프레임이 생성됩니다.

대상은 측정 구간 전체를 포함해야 하며 정방향 100% 속도여야 합니다. 위치 이동만 지원합니다. 측정 중 트랙이나 클립을 편집하지 마세요. 강제 종료 시 트랙 표시 상태를 확인하세요.

## 오류 제보

[오류 제보](https://github.com/Chamhyul/premiere-mask-motion/issues/new/choose)에 OS·CPU·Premiere 버전과 표시 언어, 재현 순서 및 오류 메시지를 알려 주세요.

고급 설정의 **실제 적용 방식으로 진단 → 진단 결과 저장**으로 진단 JSON을 만들 수 있습니다. 공개 첨부 전에 클립 이름 등 프로젝트 정보를 확인해 주세요.
