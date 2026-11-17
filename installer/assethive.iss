; AssetHive Inno Setup script
; 命令行覆盖（iscc）：
;   iscc /Qp "/DMyAppVersion=1.1.5" "/DMyAppSourceDir=C:\...\AssetHive" /O"C:\...\Output" installer\assethive.iss

#ifndef MyAppVersion
  #define MyAppVersion "2.0.0"
#endif
#ifndef MyAppSourceDir
  #define MyAppSourceDir "..\Output\AssetHive"
#endif

#define MyAppName "AssetHive"
#define MyAppPublisher "BlackBlade Studio"
#define MyAppExeName "AssetHive.exe"

[Setup]
; 固定 GUID：跨版本不变，供覆盖安装 / 卸载识别
AppId={{20B0EE58-5474-4F9F-A0AB-0FE3B39D98B4}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
; per-user 时解析为 {localappdata}\Programs\AssetHive，per-machine 时解析为 {pf}\AssetHive
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; 安装向导提供 "仅当前用户 / 所有用户" 选项；选 per-machine 时自动要求管理员权限
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
; 产物名：版本紧跟 assethive- 且不带前导 v（老版本 findLocalUpdatePackage 依赖此匹配）
OutputBaseFilename=AssetHive-{#MyAppVersion}-setup-win64
SetupIconFile=..\images\v2.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
LZMAUseSeparateProcess=yes
; 深色主题，与软件界面一致；侧栏和右上角使用 AssetHive 品牌图
WizardStyle=modern dark includetitlebar
WizardImageFile=..\images\installer-wizard-sidebar.png
WizardImageBackColor=#121212
WizardSmallImageFile=..\images\installer-wizard-logo.png
WizardSmallImageBackColor=none
; 选择安装目录后直接开始，不再显示多余的“准备安装”页
DisableReadyPage=yes
; Only the Finish-page launch action may start AssetHive after installation.
RestartApplications=no
CloseApplications=yes
DisableWelcomePage=no

[Messages]
SetupWindowTitle=Asset Hive Setup
WelcomeLabel1=Install Asset Hive
WelcomeLabel2=Asset Hive - a local 3D asset library for Unreal Engine.%n%nSetup will install AssetHive on this computer.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#MyAppSourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: TrackPackagedFile

[INI]
Filename: "{app}\assethive-install.ini"; Section: "Install"; Key: "Type"; String: "exe"
Filename: "{app}\assethive-install.ini"; Section: "Install"; Key: "Scope"; String: "{code:GetInstallScope}"

[UninstallDelete]
Type: files; Name: "{app}\assethive-install.ini"

[Icons]
; Inno Setup deletes an existing link before recreating it. Preserve existing
; shortcuts (including their user-customized properties) during upgrades.
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; IconIndex: 0; AppUserModelID: "com.blackblade.assethive"; Check: not FileExists(ExpandConstant('{group}\{#MyAppName}.lnk'))
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; IconIndex: 0; AppUserModelID: "com.blackblade.assethive"; Tasks: desktopicon; Check: not FileExists(ExpandConstant('{autodesktop}\{#MyAppName}.lnk'))

[Run]
; Checked by default; launch only when the user clicks Finish, never in silent mode.
Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: postinstall nowait skipifsilent runasoriginaluser

[Code]
function GetInstallScope(Param: string): string;
begin
  if IsAdminInstallMode then Result := 'machine' else Result := 'user';
end;

{ 跳过可选的“附加任务”页：默认不创建桌面快捷方式，保持安装流程简洁 }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := PageID = wpSelectTasks;
end;

{ 已知的旧版本程序文件扩展名（这些类型的文件若未被新版本覆盖即为旧多余文件） }
const
  PROGRAM_FILE_EXTS = '.exe,.dll,.pak,.asar,.dat,.bin,.node,.so,.dylib,.lib,.exp,.pdb,.ini,.manifest,.ttf,.woff,.woff2,.icns,.ico,.png,.bmp,.webp,.js,.json,.html,.css,.svg';
  APP_ID_GUID = '{20B0EE58-5474-4F9F-A0AB-0FE3B39D98B4}';

var
  ExistingInstallPath: string;   { 检测到的已安装路径 }
  OldFilesList: TStringList;     { 安装前的旧文件清单 }
  PackagedFilesList: TStringList; { 当前安装包包含的目标文件 }

{ Check 在版本/时间戳判断之前记录文件，保留安装包内未发生变化的运行文件。 }
function TrackPackagedFile: Boolean;
begin
  if PackagedFilesList = nil then
  begin
    PackagedFilesList := TStringList.Create;
    PackagedFilesList.Sorted := True;
    PackagedFilesList.Duplicates := dupIgnore;
  end;
  PackagedFilesList.Add(LowerCase(ExpandConstant(CurrentFilename)));
  Result := True;
end;

{ 将 TFindRec 中的 LastWriteTime 转换为可比较的字符串 }
function FindRecTimeToString(const FindRec: TFindRec): string;
begin
  Result :=
    IntToStr(FindRec.LastWriteTime.dwHighDateTime) + ':' +
    IntToStr(FindRec.LastWriteTime.dwLowDateTime);
end;

{ 比较两个时间字符串是否相等 }
function TimeStringsEqual(const A, B: string): Boolean;
begin
  Result := CompareText(A, B) = 0;
end;

{ 判断某文件扩展名是否属于程序文件 }
function IsProgramFileExt(const FileName: string): Boolean;
var
  Ext: string;
  ExtList: TStringList;
  I: Integer;
begin
  Result := False;
  Ext := LowerCase(ExtractFileExt(FileName));
  ExtList := TStringList.Create;
  try
    ExtList.Delimiter := ',';
    ExtList.StrictDelimiter := True;
    ExtList.DelimitedText := PROGRAM_FILE_EXTS;
    for I := 0 to ExtList.Count - 1 do
    begin
      if LowerCase(ExtList[I]) = Ext then
      begin
        Result := True;
        Break;
      end;
    end;
  finally
    ExtList.Free;
  end;
end;

{ 从注册表中查找已安装路径（同时查 HKCU 和 HKLM，兼顾 per-user 和 per-machine） }
function FindExistingInstallPath: string;
var
  UninstallKey: string;
  RootKeys: array[0..1] of Integer;
  I: Integer;
begin
  Result := '';
  RootKeys[0] := HKCU;
  RootKeys[1] := HKLM;
  UninstallKey := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + APP_ID_GUID + '_is1';

  for I := 0 to 1 do
  begin
    if RegQueryStringValue(RootKeys[I], UninstallKey, 'InstallLocation', Result) then
    begin
      if (Result <> '') and DirExists(Result) then
        Break;
      Result := '';
    end;
  end;
end;

{ 递归收集目录下所有文件到列表，格式为：相对路径|时间字符串 }
procedure CollectFiles(const BaseDir, CurrentDir: string; List: TStringList);
var
  FindRec: TFindRec;
  FullPath, RelPath: string;
begin
  if FindFirst(CurrentDir + '\*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          FullPath := CurrentDir + '\' + FindRec.Name;
          RelPath := Copy(FullPath, Length(BaseDir) + 2, Length(FullPath) - Length(BaseDir) - 1);

          if FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0 then
          begin
            CollectFiles(BaseDir, FullPath, List);
          end
          else
          begin
            List.Add(RelPath + '|' + FindRecTimeToString(FindRec));
          end;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

{ 初始化安装向导前：检测是否已安装，若是则把默认安装目录指向原位置 }
procedure InitializeWizard;
begin
  ExistingInstallPath := FindExistingInstallPath;
  if (ExistingInstallPath <> '') and (ExpandConstant('{param:DIR|}') = '') then
  begin
    WizardForm.DirEdit.Text := ExistingInstallPath;
  end;
end;

{ 递归删除空子目录（自底向上，跳过根目录本身） }
procedure RemoveEmptySubdirs(const RootDir: string);
var
  FindRec: TFindRec;
  SubPath: string;
begin
  if FindFirst(RootDir + '\*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') and
           ((FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) then
        begin
          SubPath := RootDir + '\' + FindRec.Name;
          { 先递归处理子目录 }
          RemoveEmptySubdirs(SubPath);
          { 再尝试删除当前目录（若为空则成功） }
          RemoveDir(SubPath);
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

{ 安装前准备：如果目标目录已存在，则记录旧文件清单（含修改时间） }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  TargetDir: string;
begin
  Result := '';
  OldFilesList := TStringList.Create;
  OldFilesList.Sorted := True;
  OldFilesList.Duplicates := dupIgnore;

  TargetDir := WizardDirValue;
  if DirExists(TargetDir) then
  begin
    CollectFiles(TargetDir, TargetDir, OldFilesList);
  end;
end;

{ 从列表行中解析出相对路径 }
function ParseRelPath(const Line: string): string;
var
  PipePos: Integer;
begin
  PipePos := Pos('|', Line);
  if PipePos > 0 then
    Result := Copy(Line, 1, PipePos - 1)
  else
    Result := Line;
end;

{ 从列表行中解析出文件修改时间字符串 }
function ParseFileTimeStr(const Line: string): string;
var
  PipePos: Integer;
begin
  Result := '';
  PipePos := Pos('|', Line);
  if PipePos > 0 then
  begin
    Result := Copy(Line, PipePos + 1, Length(Line) - PipePos);
  end;
end;

{ 安装后清理：仅删除不在当前安装包中的旧程序文件，并保留被修改过的文件。 }
procedure CurStepChanged(CurStep: TSetupStep);
var
  TargetDir: string;
  I: Integer;
  Line, RelPath, FullPath: string;
  OldTimeStr, NewTimeStr: string;
  FindRec: TFindRec;
  DeletedCount: Integer;
  CleanupLog: TStringList;
begin
  { ssPostInstall = 所有文件复制完成，还未显示结束页 }
  if CurStep = ssPostInstall then
  begin
    TargetDir := WizardDirValue;
    if (OldFilesList = nil) or (OldFilesList.Count = 0) then
      Exit;
    { 未获得安装包文件清单时不执行删除。 }
    if (PackagedFilesList = nil) or (PackagedFilesList.Count = 0) then
      Exit;

    DeletedCount := 0;
    CleanupLog := TStringList.Create;
    try
      for I := 0 to OldFilesList.Count - 1 do
      begin
        Line := OldFilesList[I];
        RelPath := ParseRelPath(Line);
        OldTimeStr := ParseFileTimeStr(Line);
        FullPath := TargetDir + '\' + RelPath;

        { 时间戳相同并不代表文件已废弃：安装包内的文件始终保留。 }
        if PackagedFilesList.IndexOf(LowerCase(FullPath)) >= 0 then
          Continue;

        { 文件仍然存在才需要检查 }
        if FileExists(FullPath) then
        begin
          { 只清理程序文件类型，避免误删用户自行放入的文档等 }
          if not IsProgramFileExt(FullPath) then
            Continue;

          { 跳过卸载程序相关文件，防止损坏卸载信息 }
          if (Pos('unins0', LowerCase(RelPath)) = 1) or
             (LowerCase(RelPath) = 'assethive-install.ini') or
             (Pos('_install_cleanup', LowerCase(RelPath)) > 0) then
            Continue;

          { 读取文件当前的修改时间 }
          if FindFirst(FullPath, FindRec) then
          begin
            try
              NewTimeStr := FindRecTimeToString(FindRec);
            finally
              FindClose(FindRec);
            end;

            { 不在安装包内且安装期间未被修改，才作为旧多余文件清理。 }
            if TimeStringsEqual(NewTimeStr, OldTimeStr) then
            begin
              if DeleteFile(FullPath) then
              begin
                Inc(DeletedCount);
                CleanupLog.Add('Deleted old file: ' + RelPath);
              end;
            end;
          end;
        end;
      end;

      { 清理完成后，删除空目录 }
      RemoveEmptySubdirs(TargetDir);

      { 写一份清理日志（便于排查问题） }
      if DirExists(TargetDir) then
      begin
        CleanupLog.Insert(0, 'Cleanup done. Deleted ' + IntToStr(DeletedCount) + ' old leftover file(s).');
        CleanupLog.SaveToFile(TargetDir + '\_install_cleanup.log');
      end;
    finally
      CleanupLog.Free;
      if OldFilesList <> nil then
      begin
        OldFilesList.Free;
        OldFilesList := nil;
      end;
    end;
  end;
end;

{ 卸载注册表项（_is1 后缀为 Inno Setup 命名约定） }
{ 无需卸载旧版本；因为 AppId 相同，Inno Setup 会自动更新卸载信息 }
