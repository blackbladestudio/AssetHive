# AssetHive

一个类似 Bridge 的本地 3D 资产管理器，为 Unreal Engine 工作流而设计。它可以扫描本地资产库、管理材质 / 贴图 / HDRI / 3D 模型等资源，并一键导入到 UE 项目中。

项目由两部分组成：

- **桌面端（Electron + React）**：资产浏览、搜索、标签、收藏、预览与导入控制
- **UE 插件（AssetHive）**：在编辑器内提供工具栏 / TCP 通信 / 导入命令，配合桌面端完成资产导入

## 功能特性

- **本地资产扫描**：扫描 Megascans / Quixel Bridge 下载目录与自定义资产库，自动识别资产类型（3D 模型、贴图、材质、HDRI、植被、贴花、置换等）
- **分类概览**：按类别浏览资产，支持「最近使用」与收藏
- **模糊搜索**：基于文件名、标签、语义标签的多维检索（fuse.js）
- **标签体系**：自动从 Megascans 元数据推断标签，并支持手动维护
- **预览与抠图**：本地缩略图生成、带透明通道的预览抠图
- **一键导入 UE**：通过 TCP 与 UE 插件通信，将资产导入到指定项目 / 引擎，自动选择合适贴图槽位与材质
- **导入 3DCoat**：从资产右键菜单或详情面板发送 FBX / OBJ / STL / PLY 模型，选择贴图绘制、体素雕刻或重拓扑用途；详见 [3DCoat 导入](docs/3dcoat-import.md)
- **尺寸对比**：在预览中可视化资产尺寸与人形比例
- **设置管理**：自定义 / Megascans 目录、目标项目、UE 引擎路径、配色等，均持久化到本地

## 目录结构

```
├── electron/          # Electron 主进程（扫描、索引、搜索、UE 导出、TCP、更新）
├── src/               # React 渲染层（App、hooks、样式、尺寸对比、错误边界）
├── scripts/           # 批处理脚本（批量导入、压缩预览、自动发布等）
├── images/            # 应用图标（安装器 / 窗口 / 插件用）
├── installer/         # Inno Setup 安装脚本（打包安装器）
├── updater/           # 内置更新器源码（C#，打包时编译为 AssetHiveUpdater.exe）
├── UE/HiveTest/       # UE 测试工程（内含 AssetHive 插件源码与材质资源）
├── AssetHive-UE-Plugin/  # 编译后的 UE 插件分发目录（构建脚本产物）
├── preview_assethive.bat    # 一键预览运行（自动安装 Node / npm 依赖）
├── package_assethive_exe.bat # 一键打包 exe / 安装器（自动补依赖、下载 Inno Setup）
└── build_assethive_plugin_precompiled.bat  # 编译 UE 插件
```

## 环境要求

- **Node.js 22.12+ / 24 LTS**（含 npm）—— 缺失或版本过旧时，脚本自动下载便携版 Node.js 24 到 `tools/node`，无需全局安装
- **Unreal Engine 5.5**（可选）—— 使用 / 编译 UE 插件
- **Windows 10/11** —— 当前主要支持平台

> `node_modules`、UE 编译产物（`Binaries` / `Intermediate`）、打包输出（`Output` / `dist`）等均不入库，首次运行脚本会自动安装 / 下载依赖。

## 快速开始

### 运行桌面端（预览）

双击 `preview_assethive.bat`，脚本会自动：

1. 检查 Node.js 和 npm，缺失或版本过旧时自动下载并校验便携版
2. 检查已安装包的版本、命令入口和 Sharp/WebP 原生模块；缺失或安装不完整时按锁文件执行 `npm ci`（无锁文件时使用 `npm install`）
3. 检查 Electron 可执行文件、版本及实际启动能力；缺失时单独下载，超时或失败时自动尝试备用源
4. 清理上次预览可能残留的仓库内 Electron 进程（`scripts/kill-stale-electron.cjs`，预览 / `npm run dev` / 打包脚本共用），清理中断预览遗留的临时 userData，并使用独立临时 userData，避免残留单实例锁阻塞下一次预览；预览启动器被强行关闭时，Electron 侧看门狗会在启动器消失后自行退出
5. 启动 Vite 开发服务并打开 Electron 窗口

也可使用 `preview/_assethive.bat` 或 `preview_assethive.ps1`。预览、打包、发布、批量导入、预览图压缩、版本修改的 BAT 入口共用 `scripts/ensure_dependencies.ps1`，按需检查依赖。下载缓存放在 `.cache`，已有且有效的依赖会直接复用。

开发预览和打包版默认写入运行日志，无需设置环境变量。开发预览的日志在项目目录 `Log/assethive.log`；打包版在用户数据目录 `Log/assethive.log`（Windows 通常为 `%APPDATA%/AssetHive/Log/assethive.log`）。日志包含主进程错误、渲染层警告与错误、渲染进程退出等信息，超过 4 MB 时保留最近约 2 MB。

只检查和修复依赖、不启动软件：`preview_assethive.bat -CheckDependenciesOnly`。打包和辅助 BAT 使用 `--check-deps`。网络失败会打印原因并返回非零退出码；重新运行即可重试。可通过 `ELECTRON_MIRROR` 指定 Electron 下载源。`_OPAQUE` 不透明裁切由应用内的独立处理器完成，无需安装或下载 Blender。UE 引擎仍需自行安装。

### 打包 exe / 安装器

双击 `package_assethive_exe.bat`，脚本会：

1. 检查 Node 与依赖，缺失时自动安装
2. 构建渲染层并调用 `@electron/packager` 打包
3. 编译 `AssetHiveUpdater.cs` 生成更新器
4. 自动下载并静默安装 Inno Setup（缺失时），最后生成安装器

### 编译 UE 插件

运行 `build_assethive_plugin_precompiled.bat`，脚本会先自动扫描本机已安装的 UE 引擎并列出版本供选择，再用所选引擎编译插件并输出到 `AssetHive-UE-Plugin/`。设置 `ASSETHIVE_ENGINE`（引擎根目录，或 `5.5` 这样的版本号）可跳过选择。

### 导入资产到 UE

在桌面端选择资产后，点击「导入」；配合已安装的 AssetHive 插件，资产会自动进入 UE 项目内容目录。

UE 插件设置 `Project Settings > Plugins > AssetHive > Import Root Path` 控制新导入路径，默认 `Content/AssetHive`。桌面端与插件通过纯 TCP 交换任务与进度，不再生成通信 JSON 文件。详见 [通信与路径设置](docs/unreal-live-import.md)。

## 常见脚本

| 脚本 | 作用 |
| --- | --- |
| `scripts/publish_release.js` | 发布脚本核心（版本识别、tag 检查、Release API 调用） |
| `scripts/batch_import_assets.js` | 批量导入资产（支持 7-Zip 自动发现 / 指定路径） |
| `scripts/compress_library_previews.js` | 压缩资产库预览图 |
| `scripts/change_version.js` | 更新应用版本号 |
| `scripts/check-unused-deps.cjs` | 检查未使用的依赖 |
| `scripts/kill-stale-electron.cjs`（`npm run kill:preview`） | 清理仓库内残留的 Electron / AssetHive 预览进程 |

### 一键发布新版本

运行 `node scripts/publish_release.js`，脚本会：

1. 自动读取 `package.json` 中的当前版本号
2. 校验当前版本的安装包与 SHA-256；版本号须在打包前修改并提交
3. 输入本次更新内容（多行，空行结束）
4. 向 `blackbladestudio/AssetHive` 创建草稿 Release，使用 `v<版本>` 标签，不覆盖已有发布
5. 上传 MSI、两种 EXE 安装包及校验和；全部上传成功后转为正式发布

> 完整发布物使用 `npm run package:msi` 构建。发布前运行 `node scripts/publish_release.js --notes-file docs/release-notes-<版本>.md --dry-run`，仅检查本地文件，不读取凭据或发布。PowerShell 入口 `scripts/publish_assethive_release.ps1 -WhatIf` 执行相同检查。
> 正式安装包从对应版本的源码 tag 构建，例如 `v2.3.5`。先提交版本号并推送 tag，再在隔离源码快照中打包；主分支后续提交留待下一版本，不移动既有发布标签。

桌面源码维护在 `Biscuits-Lab/Assethive_Sourcecode`，`blackbladestudio/AssetHive` 同时保留发布源码和 GitHub Actions。发布前将对应源码 tag 的应用文件同步到发布仓库，并用 `node scripts/release-source.cjs --version <版本> --out <发布仓库>/docs/release-source-<版本>.json` 生成来源记录。提交同步候选并核对记录后，再在发布仓库创建版本 tag；发布脚本会检查版本和应用源码，拒绝给旧代码打新版本标签。

发布仓库的 Actions 支持手动指定 tag：未发布的版本继续构建；已发布的版本只核对源码、说明和附件校验和，通过后跳过重复发布。公开 tag 与上传附件的源码必须一致。

## 技术栈

- **桌面端**：Electron 40 · React 19 · Vite 7 · TypeScript · three.js（预览渲染）
- **后端能力**：chokidar（文件监听）· fuse.js（搜索）· sharp（图片处理）
- **UE 插件**：C++（AssetHive Module / Toolbar / TCP Server / Import Commandlet）
- **打包**：@electron/packager · Inno Setup

## 开发注意

预览和网格回归检查：

```bash
npm run test:cards
npm run test:3dcoat
npm run test:3dcoat:electron
npm run test:previews
npm run test:previews:electron
npm run typecheck
npm run build
```

Electron 检查使用独立临时目录和隐藏窗口，验证无鼠标交互加载、快速滚动、缩略图失败回退、特殊字符路径及卡片交互，不读取用户资源库。结果 JSON 和截图的目录会打印到控制台。它不能替代真实大资源库的长期性能测试。

卡片缩略图使用共享限流队列和有容量上限的内存缓存；只通知对应图片更新，滚动预加载通过网格区间索引查询。已挂载卡片主动加载缩略图，失败后回退原图；详情大图仍使用原来的完整预览路径。

- **Megascans 的 `assetsData.json` 文件请勿改动**，资产扫描依赖它
- 编辑资产菜单与导入资产菜单需始终保持一致
- 当前 UE 插件源码维护在 https://github.com/Biscuits-Lab/AssetHivePlugin，本地工作副本位于 `UE/HiveTest/Plugins/AssetHive`（已被 git 忽略）；修改后运行 `build_assethive_plugin_precompiled.bat` 重新编译分发

## 许可

ISC

---

> 注意：`UE/HiveTest/Saved`、`Binaries`、`Intermediate` 等本地编译产物不入库；Megascans 相关逻辑依赖本地下载目录中的 `assetsData.json` 元数据。
