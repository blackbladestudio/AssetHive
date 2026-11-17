# AssetHive

AssetHive 是面向 Unreal Engine 工作流的 Windows 桌面资产管理器。

当前桌面版本为 **2.3.3**，使用 Electron 44、React 和 Vite。角色模块支持套装、怪物、NPC、武器、脸部、HairCard 和 Groom ABC。

## 开发

要求 Windows 10/11 x64、Node.js 24 LTS 和 npm。Groom 自动预览需要本机安装 Blender，可在设置中指定路径。

```powershell
npm ci
npm run dev
```

常用检查：

```powershell
npm run lint
npm run typecheck
npm run test:character
npm run test:updates
npm run build
```

## Unreal 插件与工程更新

桌面客户端和 UE 工程插件分别交付。当前 Windows 安装包不携带或覆盖工程插件；工程插件由团队维护者从已验证的插件源码同步到项目的 `Plugins/AssetHive`，按目标 UE 版本编译，再通过项目的版本管理分发。

本仓库保留的 `UE/HiveTest/Plugins/AssetHive` 与 `AssetHive-UE-Plugin` 是历史 UE 5.5 源码／预编译目录，不作为当前工程插件更新源，也不会被打进 2.3.3 桌面安装包。不能把 UE 5.5 DLL 当成 UE 5.8 插件使用。

构建或发布桌面应用不会执行 P4 提交。桌面更新也不会代替工程插件更新。

## 构建 Windows 安装包

还需要 .NET SDK。构建脚本使用 WiX 5.0.2、Inno Setup 6.7.3 和固定版本的 Electron Packager。缺少的构建工具安装在本地 `tools/` 下。

```powershell
npm ci
npm run package:msi
```

输出到 `Output/`：

- `AssetHive-<version>-Windows.msi`：供 BlackBlade Hub／MSI 升级使用。
- `AssetHive-<version>-Windows-setup.exe`：带安装界面的 MSI 包装器。
- `AssetHive-<version>-setup-win64.exe`：供已有 EXE 安装用户升级使用。
- 每个安装包对应一个 `.sha256` 文件。

保留检查目录时可运行：

```powershell
npm run package:msi -- -KeepStage
node scripts/verify-release-package.cjs
```

版本来自 `package.json` 和锁文件。MSI 延续现有 2.x 的 UpgradeCode，EXE 延续原有 AppId；升级时保持原来的安装类型。

## 发布

1. 同步经过验证的桌面源码，更新 `package.json`、`package-lock.json` 和 `docs/release-notes-<version>.md`。
2. 完成检查、本地构建和安装包验证，提交到本仓库 `main`。
3. 创建与版本完全一致的标签，例如 `2.3.3` 对应 `v2.3.3`，并推送该标签。
4. Windows workflow 安装锁定依赖、检查类型与角色／更新测试、构建安装包、验证打包资源、计算 SHA-256，并创建 GitHub Release。
5. 核对 Release 六个附件及校验值，再确认更新端可获取最新版本。

同一版本的发布资产不得覆盖；如需修复已发布安装器，必须使用新版本。正式发布说明只写面向用户的功能、改进与问题修复。

可在 Actions secrets 设置 `WINDOWS_CERTIFICATE_BASE64` 和 `WINDOWS_CERTIFICATE_PASSWORD` 对发布附件签名。未配置证书时安装包未签名，Windows SmartScreen 可能提示。

## 权利声明

Copyright © 2026 BlackBlade Studio. All rights reserved.

本仓库源码公开可见，但未授予开源许可证。除适用法律另有规定或获得 BlackBlade Studio 书面许可外，不得复制、修改、分发或再授权本项目。
