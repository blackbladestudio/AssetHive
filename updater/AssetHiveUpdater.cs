using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text.RegularExpressions;

namespace AssetHiveUpdater
{
    internal static class Program
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int MessageBox(IntPtr window, string text, string caption, uint type);

        private static int Main(string[] args)
        {
            try { return Run(args); }
            catch (Exception error)
            {
                try { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "install-error.log"), error.ToString()); } catch { }
                MessageBox(IntPtr.Zero, "更新未完成：" + error.Message + "\n更新包已保留，可重新打开 AssetHive 后重试。", "AssetHive 更新失败", 0x10);
                return 1;
            }
        }

        private static int Run(string[] args)
        {
            var parsed = ParseArgs(args);
            var source = GetSingle(parsed, "--source");
            var target = GetSingle(parsed, "--target");
            var restart = GetSingle(parsed, "--restart");
            var cleanups = GetMany(parsed, "--cleanup");
            var package = GetSingle(parsed, "--package");
            var installType = GetSingle(parsed, "--install-type");
            var installScope = GetSingle(parsed, "--install-scope");
            if (string.IsNullOrWhiteSpace(target) || (string.IsNullOrWhiteSpace(source) && string.IsNullOrWhiteSpace(package)))
            {
                throw new ArgumentException("缺少更新目录或更新包");
            }
            var installerInfo = string.IsNullOrWhiteSpace(source)
                ? CreateInstallerStartInfo(package, target, installType, installScope) : null;
            if (!string.IsNullOrWhiteSpace(source) && !string.IsNullOrWhiteSpace(package)
                && (installType != "portable" || PackageType(package) != "portable"))
                throw new ArgumentException("当前安装类型不支持 ZIP 覆盖更新");

            int waitPid;
            if (int.TryParse(GetSingle(parsed, "--wait-pid"), out waitPid))
            {
                Process parent = null;
                try { parent = Process.GetProcessById(waitPid); } catch (ArgumentException) { }
                if (parent != null)
                {
                    using (parent)
                        if (!parent.WaitForExit(120000)) throw new IOException("AssetHive 尚未退出，已取消覆盖");
                }
            }

            if (string.IsNullOrWhiteSpace(source))
            {
                using (var installer = Process.Start(installerInfo))
                {
                    if (installer == null) throw new IOException("安装程序未启动");
                    installer.WaitForExit();
                    if (installer.ExitCode != 0 && !(installType == "msi" && installer.ExitCode == 3010))
                        throw new IOException("安装程序退出码：" + installer.ExitCode);
                }
            }
            else
            {
                var copied = false;
                for (var i = 0; i < 80; i++)
                {
                    try
                    {
                        CopyDirectory(source, target);
                        copied = true;
                        break;
                    }
                    catch
                    {
                        Thread.Sleep(250);
                    }
                }
                if (!copied)
                {
                    throw new IOException("无法覆盖程序文件，请检查安装目录权限或占用情况");
                }
            }

            if (!string.IsNullOrWhiteSpace(restart) && File.Exists(restart))
            {
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = restart,
                        UseShellExecute = true,
                        WorkingDirectory = Path.GetDirectoryName(restart) ?? target
                    });
                }
                catch
                {
                    throw new IOException("更新完成，但无法重新打开 AssetHive");
                }
            }

            foreach (var item in cleanups)
            {
                if (string.IsNullOrWhiteSpace(item))
                {
                    continue;
                }
                try
                {
                    if (Directory.Exists(item))
                    {
                        Directory.Delete(item, true);
                        continue;
                    }
                    if (File.Exists(item))
                    {
                        File.Delete(item);
                    }
                }
                catch
                {
                }
            }

            return 0;
        }

        private static string PackageType(string package)
        {
            var name = Path.GetFileName(package).ToLowerInvariant();
            if (!name.StartsWith("assethive-") || Regex.IsMatch(name, @"(?:^|[-_])(arm64|ia32|x86)(?:[-_.]|$)")) return "";
            if (name.EndsWith(".msi") || name.EndsWith("-windows-setup.exe")) return "msi";
            if (Regex.IsMatch(name, @"-setup-(win64|x64)\.exe$")) return "exe";
            if (name.EndsWith(".zip")) return "portable";
            return "";
        }

        // Keep the original install scope even for machine installations on D:\ or
        // user installations run from an elevated app. The path cannot tell scope.
        private static ProcessStartInfo CreateInstallerStartInfo(string package, string target, string installType, string scope)
        {
            if ((installType != "exe" && installType != "msi") || PackageType(package) != installType)
                throw new ArgumentException("更新包与当前安装类型不一致");
            if ((scope != "user" && scope != "machine") || (installType == "msi" && scope != "machine"))
                throw new ArgumentException("安装范围无效");
            var isMsiFile = package.EndsWith(".msi", StringComparison.OrdinalIgnoreCase);
            var arguments = isMsiFile
                ? "/i " + Quote(package) + " /qn /norestart INSTALLFOLDER=" + Quote(target)
                : "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /DIR=" + Quote(target);
            if (installType == "exe") arguments += scope == "machine" ? " /ALLUSERS" : " /CURRENTUSER";
            return new ProcessStartInfo
            {
                FileName = isMsiFile ? "msiexec.exe" : package,
                Arguments = arguments,
                UseShellExecute = true,
                Verb = scope == "machine" ? "runas" : "",
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(package)
            };
        }

        private static string Quote(string value)
        {
            // Windows filenames cannot contain a quote. Reject instead of accepting extra arguments.
            if (value.Contains("\"")) throw new ArgumentException("更新路径含有非法字符");
            return "\"" + value.TrimEnd('\\') + "\"";
        }

        private static Dictionary<string, List<string>> ParseArgs(string[] args)
        {
            var map = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < args.Length; i++)
            {
                var key = args[i];
                if (!key.StartsWith("--", StringComparison.Ordinal))
                {
                    continue;
                }
                var value = i + 1 < args.Length ? args[i + 1] : "";
                if (value.StartsWith("--", StringComparison.Ordinal))
                {
                    value = "";
                }
                else
                {
                    i += 1;
                }
                List<string> values;
                if (!map.TryGetValue(key, out values))
                {
                    values = new List<string>();
                    map[key] = values;
                }
                values.Add(value ?? "");
            }
            return map;
        }

        private static string GetSingle(Dictionary<string, List<string>> parsed, string key)
        {
            List<string> values;
            if (!parsed.TryGetValue(key, out values) || values.Count == 0)
            {
                return "";
            }
            return values[0] ?? "";
        }

        private static List<string> GetMany(Dictionary<string, List<string>> parsed, string key)
        {
            List<string> values;
            if (!parsed.TryGetValue(key, out values) || values.Count == 0)
            {
                return new List<string>();
            }
            return values.Where((value) => !string.IsNullOrWhiteSpace(value)).ToList();
        }

        private static void CopyDirectory(string sourceDir, string targetDir)
        {
            var sourceInfo = new DirectoryInfo(sourceDir);
            if (!sourceInfo.Exists)
            {
                throw new DirectoryNotFoundException(sourceDir);
            }
            Directory.CreateDirectory(targetDir);
            foreach (var dir in sourceInfo.GetDirectories("*", SearchOption.AllDirectories))
            {
                var relative = dir.FullName.Substring(sourceInfo.FullName.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var dest = Path.Combine(targetDir, relative);
                Directory.CreateDirectory(dest);
            }
            foreach (var file in sourceInfo.GetFiles("*", SearchOption.AllDirectories))
            {
                var relative = file.FullName.Substring(sourceInfo.FullName.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var dest = Path.Combine(targetDir, relative);
                var parent = Path.GetDirectoryName(dest);
                if (!string.IsNullOrWhiteSpace(parent))
                {
                    Directory.CreateDirectory(parent);
                }
                file.CopyTo(dest, true);
            }
        }
    }
}
