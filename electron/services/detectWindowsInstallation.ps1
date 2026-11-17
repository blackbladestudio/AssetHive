param([string]$AppRoot = $env:ASSETHIVE_UPDATE_APP_ROOT)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd('\')
$taskMatches = @()
$taskUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{20B0EE58-5474-4F9F-A0AB-0FE3B39D98B4}_is1'

foreach ($taskHive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($taskView in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $taskBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey($taskHive, $taskView)
        try {
            $taskKey = $taskBase.OpenSubKey($taskUninstallKey)
            if ($null -ne $taskKey) {
                try {
                    $taskLocation = [string]$taskKey.GetValue('InstallLocation')
                    if ($taskLocation -and [IO.Path]::GetFullPath($taskLocation).TrimEnd('\') -ieq $AppRoot) {
                        $taskScope = if ($taskHive -eq [Microsoft.Win32.RegistryHive]::CurrentUser) { 'user' } else { 'machine' }
                        $taskMatches += @{ type = 'exe'; scope = $taskScope }
                    }
                } finally { $taskKey.Dispose() }
            }
        } finally { $taskBase.Dispose() }
    }
}

# Read-only Windows Installer queries. Never query Win32_Product (it can repair installations).
$taskInstaller = New-Object -ComObject WindowsInstaller.Installer
$taskProducts = $taskInstaller.GetType().InvokeMember('RelatedProducts', 'GetProperty', $null, $taskInstaller, @('{9F0A2C6E-8B4D-4A7E-9C1B-3D5F7E2A9B1C}'))
foreach ($taskProduct in $taskProducts) {
    $taskLocation = $taskInstaller.GetType().InvokeMember('ProductInfo', 'GetProperty', $null, $taskInstaller, @($taskProduct, 'InstallLocation'))
    $taskMatched = $taskLocation -and [IO.Path]::GetFullPath($taskLocation).TrimEnd('\') -ieq $AppRoot
    if (-not $taskLocation) {
        # Old MSI packages omitted ARPINSTALLLOCATION; resolve the installed EXE
        # through the cached MSI's component key, without installing or repairing it.
        $taskCache = $taskInstaller.GetType().InvokeMember('ProductInfo', 'GetProperty', $null, $taskInstaller, @($taskProduct, 'LocalPackage'))
        $taskDatabase = $taskInstaller.OpenDatabase($taskCache, 0)
        $taskQuery = 'SELECT `Component`.`ComponentId`, `File`.`FileName` FROM `Component`, `File` WHERE `Component`.`KeyPath` = `File`.`File`'
        $taskQueryView = $taskDatabase.OpenView($taskQuery)
        try {
            $taskQueryView.Execute()
            while ($null -ne ($taskRecord = $taskQueryView.Fetch())) {
                if (($taskRecord.StringData(2) -split '\|')[-1] -ine 'AssetHive.exe') { continue }
                $taskComponent = $taskRecord.StringData(1)
                $taskExe = $taskInstaller.GetType().InvokeMember('ComponentPath', 'GetProperty', $null, $taskInstaller, @($taskProduct, $taskComponent))
                if ($taskExe -and [IO.Path]::GetDirectoryName($taskExe).TrimEnd('\') -ieq $AppRoot) { $taskMatched = $true }
            }
        } finally { $taskQueryView.Close() }
    }
    if ($taskMatched) { $taskMatches += @{ type = 'msi'; scope = 'machine' } }
}

$taskMatches = @($taskMatches | Sort-Object -Property type, scope -Unique)
if ($taskMatches.Count -eq 1) {
    $taskMatches[0] | ConvertTo-Json -Compress
} elseif ($taskMatches.Count -gt 1 -or (Get-ChildItem -LiteralPath $AppRoot -Filter 'unins*.exe' -File -ErrorAction SilentlyContinue)) {
    throw '安装记录冲突或不完整，请使用原类型安装包修复安装后再更新'
} else {
    @{ type = 'portable'; scope = 'user' } | ConvertTo-Json -Compress
}
