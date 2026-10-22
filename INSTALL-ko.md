# Mask Tracker 설치

현재 설치 파일은 **Apple Silicon 맥용**이며, Premiere 26.5.2에서 확인했습니다.

1. GitHub의 **[Releases](https://github.com/Chamhyul/premiere-mask-tracker/releases)**에서 **macOS-arm64 ZIP**을 받아 압축을 풉니다.
2. **CCX 파일**을 더블클릭해 Creative Cloud Desktop에서 설치합니다.
3. **MaskTrackerClipboard.bundle**을 아래 폴더에 넣습니다. Finder의 **이동 → 폴더로 이동**에서 경로를 입력하세요.

   ```text
   /Library/Application Support/Adobe/Common/Plug-ins/ControlSurface/
   ```

4. Premiere의 **환경 설정 → 컨트롤 표면 → 추가**에서 **Mask Tracker**를 선택합니다. 이 설정은 처음 한 번만 하면 됩니다.
5. **창 → UXP 플러그인 → Mask Tracker**를 엽니다.

목록에 나타나지 않으면 Premiere를 다시 실행하세요. 업데이트할 때는 Premiere를 종료하고 CCX와 네이티브 모듈을 함께 교체합니다.

[사용 방법](README.md)
