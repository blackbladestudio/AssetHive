$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskRoot = Join-Path $taskRepo ('.cache\update-helper-test-' + [guid]::NewGuid().ToString('N'))
$taskTarget = Join-Path $taskRoot 'installed app'
$taskStage = Join-Path $taskRoot 'stage'
New-Item -ItemType Directory -Path $taskTarget, $taskStage -Force | Out-Null
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskHelper = Join-Path $taskRoot 'AssetHiveUpdater.exe'
& $taskCompiler /nologo /target:winexe /out:$taskHelper (Join-Path $taskRepo 'updater\AssetHiveUpdater.cs')
if ($LASTEXITCODE -ne 0) { throw 'Updater compilation failed' }

# A real Windows executable simulates an installer and the restarted app without
# modifying the registry or any actual AssetHive installation.
$taskFakeSource = Join-Path $taskRoot 'FakeInstaller.cs'
@'
using System;
using System.IO;
using System.Threading;
class FakeInstaller {
    static void Main(string[] args) {
        var root = AppDomain.CurrentDomain.BaseDirectory;
        if (args.Length == 1 && args[0] == "--wait") { Thread.Sleep(1500); return; }
        if (args.Length == 0) { File.WriteAllText(Path.Combine(root, "restarted.txt"), "yes"); return; }
        File.WriteAllLines(Path.Combine(root, "installer-args.txt"), args);
        foreach (var arg in args) if (arg.StartsWith("/DIR="))
            File.WriteAllText(Path.Combine(arg.Substring(5), "version.txt"), "updated");
    }
}
'@ | Set-Content -LiteralPath $taskFakeSource -Encoding UTF8
$taskInstaller = Join-Path $taskRoot 'AssetHive-2.2.10-setup-win64.exe'
& $taskCompiler /nologo /target:winexe /out:$taskInstaller $taskFakeSource
if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed' }
$taskRestart = Join-Path $taskTarget 'AssetHive.exe'
Copy-Item -LiteralPath $taskInstaller -Destination $taskRestart
$taskParent = Start-Process -FilePath $taskInstaller -ArgumentList '--wait' -WindowStyle Hidden -PassThru
$taskArguments = '--package "{0}" --target "{1}" --wait-pid {2} --restart "{3}" --install-type exe --install-scope user' -f $taskInstaller, $taskTarget, $taskParent.Id, $taskRestart
$taskClock = [Diagnostics.Stopwatch]::StartNew()
$taskProcess = Start-Process -FilePath $taskHelper -ArgumentList $taskArguments -WindowStyle Hidden -Wait -PassThru
if ($taskProcess.ExitCode -ne 0) { throw ('Updater failed: ' + $taskProcess.ExitCode) }
if ($taskClock.ElapsedMilliseconds -lt 1000) { throw 'Updater did not wait for the app process' }
if ((Get-Content -LiteralPath (Join-Path $taskTarget 'version.txt') -Raw) -ne 'updated') { throw 'Incorrect installation directory' }
$taskInstallerArgs = Get-Content -LiteralPath (Join-Path $taskRoot 'installer-args.txt')
if ($taskInstallerArgs -notcontains '/VERYSILENT' -or $taskInstallerArgs -notcontains ('/DIR=' + $taskTarget)) { throw 'Incorrect silent installer arguments' }
if ($taskInstallerArgs -notcontains '/CURRENTUSER' -or $taskInstallerArgs -contains '/ALLUSERS') { throw 'User installation changed scope' }
for ($taskAttempt = 0; $taskAttempt -lt 30 -and -not (Test-Path -LiteralPath (Join-Path $taskTarget 'restarted.txt')); $taskAttempt++) { Start-Sleep -Milliseconds 100 }
if (-not (Test-Path -LiteralPath (Join-Path $taskTarget 'restarted.txt'))) { throw 'App did not restart after installation' }

# Exercise the ZIP/portable copy path separately.
Set-Content -LiteralPath (Join-Path $taskStage 'copied.txt') -Value 'new files'
$taskCopyArguments = '--source "{0}" --target "{1}"' -f $taskStage, $taskTarget
$taskCopy = Start-Process -FilePath $taskHelper -ArgumentList $taskCopyArguments -WindowStyle Hidden -Wait -PassThru
if ($taskCopy.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $taskTarget 'copied.txt'))) { throw 'Portable update copy failed' }

# Inspect generated commands without invoking MSI or requesting elevation.
$taskAssembly = [Reflection.Assembly]::LoadFile($taskHelper)
$taskProgram = $taskAssembly.GetType('AssetHiveUpdater.Program')
$taskCreate = $taskProgram.GetMethod('CreateInstallerStartInfo', [Reflection.BindingFlags]'NonPublic,Static')
$taskMachine = $taskCreate.Invoke($null, [string[]]@($taskInstaller, $taskTarget, 'exe', 'machine'))
if ($taskMachine.Arguments -notlike '*/ALLUSERS*' -or $taskMachine.Verb -ne 'runas') { throw 'Custom machine install lost scope' }
$taskMsi = Join-Path $taskRoot 'AssetHive-2.2.10-win64.msi'
$taskMsiInfo = $taskCreate.Invoke($null, [string[]]@($taskMsi, $taskTarget, 'msi', 'machine'))
if ($taskMsiInfo.FileName -ne 'msiexec.exe' -or $taskMsiInfo.Arguments -notlike '*INSTALLFOLDER=*' -or $taskMsiInfo.Arguments -notlike '*/norestart*') { throw 'Incorrect MSI upgrade command' }
$taskWrapper = Join-Path $taskRoot 'AssetHive-2.2.10-Windows-setup.exe'
$taskWrapperInfo = $taskCreate.Invoke($null, [string[]]@($taskWrapper, $taskTarget, 'msi', 'machine'))
if ($taskWrapperInfo.FileName -ne $taskWrapper -or $taskWrapperInfo.Verb -ne 'runas') { throw 'MSI wrapper lost its installer type' }
foreach ($taskCase in @(@($taskMsi, 'exe'), @($taskWrapper, 'exe'), @($taskInstaller, 'msi'))) {
    $taskRejected = $false
    try { $null = $taskCreate.Invoke($null, [string[]]@($taskCase[0], $taskTarget, $taskCase[1], 'machine')) }
    catch {
        $taskError = $_.Exception
        while ($null -ne $taskError) {
            if ($taskError -is [ArgumentException]) { $taskRejected = $true }
            $taskError = $taskError.InnerException
        }
    }
    if (-not $taskRejected) { throw 'Cross-type update was accepted' }
}
Write-Output ('Updater checks passed: wait, silent arguments, target directory, restart, portable copy, install scope, MSI and cross-type rejection. Fixtures: ' + $taskRoot)
