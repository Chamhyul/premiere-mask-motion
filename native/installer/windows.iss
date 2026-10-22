#ifndef StageDir
  #error StageDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef Version
  #error Version is required
#endif
#ifndef VersionNumeric
  #error VersionNumeric is required
#endif
[Setup]
AppId=com.local.premiere.masktracker.installer
AppName=Mask Tracker
AppVersion={#Version}
VersionInfoVersion={#VersionNumeric}
DefaultDirName={autopf}\Mask Tracker
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Mask-Tracker-Windows-x64-{#Version}-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
Uninstallable=no
CloseApplications=no
RestartApplications=no
SetupLogging=yes
[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
[Messages]
FinishedHeadingLabel=Mask Tracker 설치 완료
FinishedLabel=네이티브 모듈과 CCX를 설치했습니다.%n%nPremiere의 환경 설정 → 컨트롤 표면 → 추가에서 Mask Tracker를 선택하세요. 처음 한 번만 설정하면 됩니다.
[Files]
Source: "{#StageDir}\MaskTrackerClipboard.acsrf"; DestDir: "{commonpf64}\Adobe\Common\Plug-ins\ControlSurface"; Flags: ignoreversion
Source: "{#StageDir}\Mask-Tracker-{#Version}.ccx"; DestDir: "{app}\Installer"; DestName: "Mask-Tracker.ccx"; Flags: ignoreversion
[Code]
var
  CcxInstalled: Boolean;
  CcxFailure: String;

function AgentPath: String;
begin
  Result := ExpandConstant('{commoncf64}\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Locator, Services, Processes: Variant;
begin
  Result := '';
  if not FileExists(AgentPath) then begin
    Result := 'Creative Cloud Desktop을 설치하고 로그인한 뒤 다시 실행하세요.';
    Exit;
  end;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE Name = ''Adobe Premiere Pro.exe'' OR Name = ''PremierePro.exe''');
    if Processes.Count > 0 then
      Result := 'Premiere를 종료한 뒤 다시 설치하세요.';
  except
    Result := 'Premiere 실행 상태를 확인하지 못했습니다. Windows를 다시 시작한 뒤 설치하세요.';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Started: Boolean;
begin
  if CurStep = ssPostInstall then begin
    WizardForm.StatusLabel.Caption := 'Adobe CCX 설치 중...';
    { Use the original desktop user's Adobe account, not an elevated admin's. }
    Code := -1;
    try
      Started := ExecAsOriginalUser(AgentPath,
        '/install "' + ExpandConstant('{app}\Installer\Mask-Tracker.ccx') + '"',
        '', SW_SHOW, ewWaitUntilTerminated, Code);
      CcxInstalled := Started and (Code = 0);
      if not Started then
        CcxFailure := 'Adobe 설치 도구를 실행하지 못했습니다. Creative Cloud를 확인한 뒤 설치 파일을 다시 실행하세요.'
      else if Code <> 0 then
        CcxFailure := Format('Adobe CCX 설치 실패 (코드 %d). Creative Cloud 로그인 상태를 확인한 뒤 설치 파일을 다시 실행하세요.', [Code]);
    except
      CcxInstalled := False;
      CcxFailure := 'Adobe CCX 설치 실패: ' + GetExceptionMessage;
    end;
    if not CcxInstalled then begin
      Log(CcxFailure);
      SuppressibleMsgBox(CcxFailure, mbError, MB_OK, IDOK);
    end;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and not CcxInstalled then begin
    WizardForm.FinishedHeadingLabel.Caption := 'Mask Tracker 설치 미완료';
    WizardForm.FinishedLabel.Caption := CcxFailure;
  end;
end;

function GetCustomSetupExitCode: Integer;
begin
  if CcxInstalled then Result := 0 else Result := 1;
end;
