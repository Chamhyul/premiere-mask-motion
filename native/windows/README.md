# Windows 빌드·테스트

Visual Studio 2022의 C++ 데스크톱 개발 도구, Windows SDK, Python 3.8 이상, Node.js, Inno Setup 6.3 이상, Premiere C++ SDK가 필요합니다. **x64 Developer PowerShell**에서 실행합니다.

```powershell
$env:PREMIERE_CPP_SDK = 'C:\SDK\Premiere Pro 26.0 C++ SDK'
# 저장소 또는 빌드 ZIP을 압축 해제한 최상위 폴더에서 실행합니다.
.\Build-Windows.ps1 -Sdk $env:PREMIERE_CPP_SDK
```

`dist\Mask-Tracker-Windows-x64-1.0.1-beta.1-Setup.exe`가 생성됩니다. EXE 하나로 네이티브 모듈을 배치하고 Adobe UPIA로 CCX를 설치합니다. 기존 ZIP도 함께 생성합니다. 로컬 개발 폴더 구조에서는 `distribution\dist\`에 생성됩니다. SDK의 Windows Control Surface 확장자는 `.acsrf`입니다. 빌드는 설치·게시를 하지 않습니다.

확인할 항목:

1. 설치 안내대로 연결하고, 마스크가 있는 클립을 선택하면 목록이 표시되는지 확인합니다.
2. 마스크를 추가하거나 다시 추적하고 **저장하지 않은 채** 클립을 재선택해 최신 목록과 분석 결과를 확인합니다.
3. 텍스트·이미지·파일·Premiere 클립을 각각 복사해 둔 상태에서 반복하고, 이후 붙여넣은 내용이 유지되는지 확인합니다.
4. 마스크 없는 클립, 빠른 클립·시퀀스 전환, 분석 초기화 후 다른 클립 선택도 확인합니다.

목록을 읽지 못하면 읽기 전용 형식 검사 도구를 빌드할 수 있습니다.

```powershell
python native/build-windows.py --sdk "$env:PREMIERE_CPP_SDK" --diagnostics
native/build/windows-x64/clipboard-inspect.exe
```

위 명령은 빌드 키트의 최상위 폴더에서 실행합니다. 도구는 형식명·크기·해시와 복제 가능 여부만 출력합니다. 클립보드 원문은 출력하거나 바꾸지 않습니다. 플러그인 동작 전후 출력을 비교하거나, Premiere 클립을 직접 복사한 뒤 형식을 확인하는 데 사용할 수 있습니다. 함께 생성되는 `bridge-protocol-test.exe`는 요청·인코딩 검사를 실행합니다.

Windows Premiere에서 추적한 오브젝트 마스크 목록 읽기와 클립보드 복원·검증을 확인했습니다. 실제 복사 형식은 `PProAE/Exchange/TrackItem`이었으며, 한 번의 읽기 전후 기존 클립보드 4개 형식의 크기·해시가 동일했습니다. 텍스트·이미지·파일 등 모든 입력 형식을 검증한 것은 아닙니다. 모듈은 등록된 메모리 형식에서 UTF-8·UTF-16 Premiere XML을 찾으며, 읽을 수 없는 형식이나 보존할 수 없는 클립보드는 오류 처리합니다. 저장된 프로젝트 데이터로 대체하지 않습니다.

화면 조작 없이 같은 네이티브 읽기 경로와 클립보드 복원을 검사하려면, 비디오 항목이 하나인 저장된 테스트 프로젝트를 열고 타임라인의 해당 클립 하나를 선택한 뒤 실행합니다. 먼저 위 `--diagnostics` 빌드로 검사 도구를 생성해야 합니다.

```powershell
node native/test-windows-host.js "E:\path\test.prproj"
```

이 검사는 클립보드를 직접 변경하지 않고 운영 코드의 복사·복원 경로를 호출합니다. 전후 형식·크기·해시 비교 결과와 네이티브 응답 상태를 `native/build/host-test/host-report.json`에 기록하며, 클립보드 원문과 복사된 XML은 출력하거나 보고서에 저장하지 않습니다. 분석·대상 클립 적용은 별도 확인이 필요합니다.

EXE 빌드는 `ISCC.exe`를 PATH 또는 Inno Setup 기본 설치 폴더에서 찾습니다. 다른 경로는 `MASK_TRACKER_ISCC` 환경 변수로 지정합니다.

설치 파일은 일반 더블클릭으로 실행하고 UAC 승인을 합니다. Creative Cloud가 로그인된 사용자로 실행해야 합니다. 처음부터 다른 관리자 계정으로 실행하면 해당 계정에 CCX가 설치될 수 있습니다. 설치 전 Premiere를 종료해야 하며, CCX 설치가 실패하면 성공으로 처리하지 않습니다. EXE에는 서명이 자동 추가되지 않습니다.
