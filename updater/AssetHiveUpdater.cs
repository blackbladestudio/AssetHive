using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;

namespace AssetHiveUpdater
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            var parsed = ParseArgs(args);
            var source = GetSingle(parsed, "--source");
            var target = GetSingle(parsed, "--target");
            var restart = GetSingle(parsed, "--restart");
            var cleanups = GetMany(parsed, "--cleanup");
            if (string.IsNullOrWhiteSpace(source) || string.IsNullOrWhiteSpace(target))
            {
                return 2;
            }

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
                return 3;
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
                    return 4;
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
