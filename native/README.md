# Mask Tracker 네이티브 연결

macOS와 Windows용 Premiere Control Surface입니다. 통합 설치 파일에서 UXP 패널과 함께 설치하며, 외부 키 입력 자동화나 별도 서버를 사용하지 않습니다. Windows 빌드와 검증 절차는 [Windows 안내](windows/README.md)를 참고하세요.

빌드:

```sh
python3 native/build-macos.py --sdk "/path/to/Premiere Pro 26.0 C++ SDK"
```

직접 설치할 경우 생성된 `MaskTrackerClipboard.bundle`을 `/Library/Application Support/Adobe/Common/Plug-ins/ControlSurface/`에 설치하고, Premiere의 **환경 설정 → 컨트롤 표면 → 추가 → Mask Tracker**를 한 번 설정합니다. 기존 Control Surface 장치는 유지합니다. UXP 파일만 설치하면 이 모듈은 함께 설치되지 않습니다.

타임라인에서 클립을 선택하면 패널이 최신 복사 데이터를 요청합니다. 네이티브 모듈은 클립보드의 모든 항목과 형식을 메모리에 보관하고 `cmd.edit.copy`를 실행한 뒤 원래 바이트를 복원·검증합니다. 복원이 확인되기 전에는 XML을 반환하지 않습니다. 사용자 클립보드 원문은 IPC 파일이나 로그에 기록하지 않습니다. 도중에 다른 복사가 발생하면 새 내용을 덮어쓰지 않고 요청을 실패 처리합니다.

IPC는 현재 사용자만 접근 가능한 임시 폴더에서 요청 ID·세션·유효 시간을 검증합니다. 네이티브 모듈이 없거나 복사가 실패하면 저장된 프로젝트로 대체하지 않습니다. 분석은 목록을 읽었을 때 확보한 마스크 메타데이터와 해당 PRMF 파일을 사용합니다.

`clipboard-state-test.mm`은 macOS 임시 pasteboard에서 텍스트, 바이너리, 여러 항목, 빈 상태 복원 및 다른 복사와의 충돌을 검사합니다. Windows 구현은 텍스트·등록 형식과 GDI 객체를 복제하고 복원을 검증합니다. 보존할 수 없는 형식은 복사 전에 거부합니다. Windows 실제 빌드·호스트 검증과 배포용 서명은 아직 진행하지 않았습니다.

## 통합 설치 파일 빌드

`mask-motion/`에서 `npm run build`를 실행하면 macOS는 `.pkg`, Windows x64는 `-Setup.exe`가 기존 CCX·ZIP과 함께 생성됩니다. 설치하거나 게시하지 않습니다. Windows는 MSVC·Windows SDK 외에 Inno Setup 6.3 이상이 필요합니다.

두 설치 파일은 Premiere 종료와 Adobe UPIA 존재 여부를 확인하고 네이티브 모듈을 배치한 다음, 로그인한 사용자의 Adobe 계정으로 CCX 설치를 실행합니다. CCX 설치 실패는 설치 미완료로 처리합니다. 이때 이미 배치된 네이티브 파일은 남을 수 있으므로 원인을 해결한 뒤 같은 설치 파일을 다시 실행합니다. macOS PKG와 Windows EXE는 로그인한 사용자의 컨트롤 표면 설정에 Mask Tracker를 자동 등록합니다. 기존 장치·설정은 유지하며 수정 전 백업을 남깁니다. Premiere 실행 중, 손상된 설정 또는 심볼릭 링크 경로는 변경하지 않습니다. Windows는 일반 실행으로 설치를 시작해야 합니다. 직접 관리자 권한으로 실행한 경우에는 다른 계정의 설정을 수정하지 않고 등록을 중단합니다. Premiere 환경설정 폴더가 없으면 Premiere를 한 번 실행·종료한 뒤 재설치합니다.

macOS 배포 서명은 `MASK_TRACKER_CODE_SIGN_IDENTITY`(Developer ID Application), `MASK_TRACKER_INSTALLER_SIGN_IDENTITY`(Developer ID Installer)를 지정하면 적용됩니다. 지정하지 않으면 네이티브 모듈은 ad-hoc 서명되고 PKG는 서명되지 않습니다. 공증은 자동 수행하지 않습니다. Windows EXE의 Authenticode 서명도 자동 수행하지 않습니다.

`python3 native/test-installers.py`는 시스템 파일을 바꾸지 않는 가짜 도구로 사전 조건·로그인 사용자 실행·Adobe 설치 실패 전달을 검증합니다. PKG 구조 검사나 이 테스트가 실제 설치 완료 검증을 대신하지는 않습니다.

macOS 자동 등록 검증은 `MASK_TRACKER_REGISTRATION_HELPER=/path/to/MaskTrackerRegister python3 native/test-registration.py`로 실행합니다. Premiere를 종료해야 합니다. 실제 환경에서는 기존 Mask Tracker 활성 항목만 제거한 뒤 PKG에 포함된 등록 도구를 실행했고, Premiere 26.5.2 재실행 후 수동 추가 없이 마스크 01·02·03 읽기 및 분석 완료를 확인했습니다. 기존 장치와 개별 설정도 비교해 보존을 확인했습니다. 전체 PKG 설치 UI의 재검증과는 구분합니다.


Windows 자동 등록은 `windows/MaskTrackerRegister.cpp`를 별도 EXE로 빌드해 `ExecAsOriginalUser`로 실행합니다. 현재 macOS에서 확인한 `prop.map version="4"` 구조를 엄격하게 검사하고, 다른 형식은 변경하지 않습니다. 기존 파일은 백업 후 `ReplaceFileW`로 교체하며 기존 ACL을 유지합니다. 재실행해도 활성 항목을 중복 추가하지 않습니다. 등록 실패 시 CCX 설치로 진행하지 않고 설치 미완료로 표시합니다.

`build-windows.py`는 등록 도구 빌드 후 임시 파일에서 기존 장치·개별 설정 보존, 백업, 재실행, 잘못된 XML·버전 거부, 경로 대소문자 및 정션 거부 검사를 실행합니다. 실제 환경설정에는 접근하지 않습니다. Windows Actions에서 컴파일·EXE 생성과 등록 도구 검사 7개가 통과했습니다. **실제 Windows Premiere 설정 형식 및 재실행 후 자동 연결은 아직 검증하지 않았습니다.** Windows 검증 시 기존 설정 파일과 백업을 비교하고, 수동 추가 없이 패널에서 마스크 목록을 읽을 수 있는지 확인해야 합니다.
