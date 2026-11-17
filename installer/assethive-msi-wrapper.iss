; AssetHive MSI wrapper
; The Windows Installer UI cannot be re-skinned, so this themed bootstrapper
; embeds the MSI, installs it silently, and provides the same simple dark setup
; window as AssetHive-<version>-setup-win64.exe. The MSI remains available for
; BlackBlade Hub / silent deployment.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#ifndef MsiPath
  #error MsiPath must be supplied with /DMsiPath=<path to the built MSI>
#endif

#ifndef MsiFileName
  #define MsiFileName "AssetHive-" + MyAppVersion + "-win64.msi"
#endif

#define MyAppName "AssetHive"
#define MyAppExeName "AssetHive.exe"
#define MyAppPublisher "BlackBlade Studio"

[Setup]
AppId={{C7E4A2D9-3B1F-4E6A-9D21-8F5B0C3A7E64}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableWelcomePage=no
CreateAppDir=no
CreateUninstallRegKey=no
Uninstallable=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputBaseFilename=AssetHive-{#MyAppVersion}-Windows-setup
SetupIconFile=..\images\v2.ico
UninstallDisplayIcon={autopf}\{#MyAppName}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
LZMAUseSeparateProcess=yes
WizardStyle=modern dark includetitlebar
WizardImageFile=..\images\installer-wizard-sidebar.png
WizardImageBackColor=#121212
WizardSmallImageFile=..\images\installer-wizard-logo.png
WizardSmallImageBackColor=none
CloseApplications=no
RestartApplications=no

[Messages]
SetupWindowTitle=Asset Hive Setup
WelcomeLabel1=Install Asset Hive
WelcomeLabel2=Asset Hive - a local 3D asset library for Unreal Engine.%n%nSetup will install AssetHive on this computer.

[Files]
Source: "{#MsiPath}"; DestDir: "{tmp}"; DestName: "{#MsiFileName}"; Flags: deleteafterinstall

[Run]
Filename: "{autopf}\{#MyAppName}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: postinstall nowait skipifsilent runasoriginaluser; Check: FileExists(ExpandConstant('{autopf}\{#MyAppName}\{#MyAppExeName}'))

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then
    Exit;

  WizardForm.StatusLabel.Caption := 'Installing AssetHive...';
  WizardForm.Refresh;

  if not Exec('msiexec.exe',
    '/i "' + ExpandConstant('{tmp}\{#MsiFileName}') + '" /qn /norestart INSTALLFOLDER="' + ExpandConstant('{app}') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('Unable to start the AssetHive MSI installer.', mbError, MB_OK);
    Abort;
  end;

  { 3010 = success, reboot required. Treat it as success. }
  if (ResultCode <> 0) and (ResultCode <> 3010) then
  begin
    MsgBox('AssetHive installation failed (MSI exit code ' + IntToStr(ResultCode) + ').', mbError, MB_OK);
    Abort;
  end;
end;
