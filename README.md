# AssetHive

AssetHive 是面向 Unreal Engine 工作流的桌面资产管理器。仓库同时包含：

- Electron 40 + React + Vite 桌面客户端
- Unreal Engine 5.5 Editor 插件源码与预编译分发目录
- Windows MSI 构建和 GitHub Release 工作流

## 开发

要求：

- Windows 10/11 x64
- Node.js 22 或更高版本
- npm
- 如需重新编译 UE 插件：Unreal Engine 5.5，并设置 `UE_ENGINE_ROOT`

```powershell
npm ci
npm run dev
```

常用检查：

```powershell
npm run lint
npm run typecheck
npm run build
```

## Unreal 插件

插件源码位于 `UE/HiveTest/Plugins/AssetHive`，测试宿主为 `UE/HiveTest/HiveTest.uproject`。

`build_assethive_plugin_precompiled.bat` 会使用 `UE_ENGINE_ROOT` 指向的 Unreal Engine 5.5，将预编译插件输出到 `AssetHive-UE-Plugin/AssetHive`。MSI 会把该目录作为应用资源安装，AssetHive 可将插件部署到目标引擎。

## Windows MSI

构建前请确认预编译插件 DLL 已生成：

```powershell
npm ci
npm run package:msi
```

输出：

```text
Output/installer/AssetHive-<version>-Windows.msi
```

构建过程会先生成渲染层、编译 `AssetHiveUpdater.exe`，并校验图标、Updater 和 UE 插件资源。MSI 使用固定 UpgradeCode，版本来自 `package.json`，支持 Windows 的升级与卸载。

未配置代码签名证书时，安装包为未签名状态，Windows SmartScreen 可能显示警告。正式分发前应配置仓库 Actions secrets 中的签名证书。

## 发布

1. 更新 `package.json` 版本并提交。
2. 创建完全匹配的标签，例如版本 `1.2.0` 对应 `v1.2.0`。
3. 推送标签后，Windows workflow 构建 MSI、可选签名、计算 SHA-256，并创建公开 GitHub Release。

Release 资产命名固定为：

- `AssetHive-<version>-Windows.msi`
- `AssetHive-<version>-Windows.msi.sha256`

同一版本的发布资产不得覆盖；如需修复安装器，必须发布新版本。

## 权利声明

Copyright © 2026 BlackBlade Studio. All rights reserved.

本仓库源码公开可见，但未授予开源许可证。除适用法律另有规定或获得 BlackBlade Studio 书面许可外，不得复制、修改、分发或再授权本项目。
