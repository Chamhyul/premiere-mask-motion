## Mask Motion 첫 공개 베타

Premiere에서 추적한 불투명도 마스크의 움직임을 텍스트·그래픽 등 대상 클립의 새 변형(Transform) 효과 Position 키프레임으로 옮깁니다. AE나 중첩 시퀀스는 필요하지 않습니다.

### 설치
1. 아래 Assets의 **Mask-Motion-0.3.2-beta.1.ccx**를 다운로드합니다. 자동 생성 Source code ZIP은 설치 파일이 아닙니다.
2. CCX를 더블클릭하고 Creative Cloud Desktop에서 설치합니다.
3. Premiere **창 → UXP Plugins → Mask Motion**을 엽니다.

**UXP Developer Tool 및 Developer Mode는 필요 없습니다.** Premiere 26.0 이상이 필요합니다. 설치·사용 방법은 `INSTALL-ko.md`와 저장소 README를 참고하세요.

### 사용
불투명도 마스크 추적 완료 → 원본 선택 및 클립 전체 측정 → 원본 마스크 비활성화 → 대상 클립 선택 및 적용.

### 검증 상태와 베타 제한
- Apple Silicon 맥 / Premiere 26.5.2 개발 도구 로딩 환경에서 핵심 측정·적용 확인.
- 인텔 맥과 Windows x64의 실제 실행은 미검증. 동일 CCX로 테스트합니다.
- 설치형 CCX의 설치·재실행 및 최신 패널의 전체 흐름도 이번 베타 확인 대상입니다.
- 자동 테스트 40개, 문법 검사 통과.
- 복사한 프로젝트에서 먼저 테스트해 주세요. 위치 이동만 지원하며 Scale/Rotation 추적은 지원하지 않습니다.

OS·CPU·Premiere 버전/언어와 설치/측정/적용/재실행 결과를 [Issues](https://github.com/Chamhyul/premiere-mask-motion/issues/new/choose)에 남겨 주세요. 오류가 나면 진단 JSON을 저장할 수 있습니다. 공개 첨부 전 클립 이름 등 프로젝트 정보를 확인해 주세요.

플러그인 내부 버전: **0.3.2** / 배포 태그: **v0.3.2-beta.1**
