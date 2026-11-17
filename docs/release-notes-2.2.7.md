# AssetHive 2.2.7

Windows x64。

## 本次更新

- **默认 Zion 资产判定**：没有 `ThirdParty` / `Megascans` / `PBRMAX` 标记的资产默认按 Zion 资产导出（含 Temp 资产）。
- **Temp 资产 = Zion 变体**：导出规格跟随 Zion（资产文件夹不带 `_<id>`、3D 走 `Material/Tex/Mesh`、Surface/Decal 走 `MI/Tex`），目录进各自分类下的 `Temp`（`Kits/Temp`、`Props/Temp`、`Objects/Temp` 等）；显式 Zion + Temp 为 `Objects/<二级目录>/Temp`。
- **第三方资产统一 Dressing**：带 `ThirdParty` / `Megascans` / `PBRMAX` 标记的 3D 资产即使另带 Props/Kits/MEGA/Destructible，也统一按 Dressing 档导出（`Objects/ThirdParty/...`）。
- **减面档位按 tag 推导**：非第三方 Props 15 万、Kits/MEGA/Destructible 各 10 万；第三方与取不到固定档的资产按 Dressing 档（单边 ≥5m 55 万、否则 30 万）；导入末尾统一走第二轮 Dressing 上限检查（只降不升）。
- **界面**：上方筛选栏「资产类型」下拉新增「Zion 资产」「Temp 资产」两项快捷筛选，可与其它筛选条件叠加。

## 安装包

- `AssetHive-2.2.7-Windows.msi`：供 BlackBlade Hub / 静默部署使用（推荐给自动化）。
- `AssetHive-2.2.7-Windows-setup.exe`：交互式安装程序。
- 每个安装包均提供 `.sha256` 校验文件。

## 验证边界

- Node 侧：`typecheck`、导出相关脚本（`test-image-processing`、`test-export-category-folder`）通过。
- 插件侧：UE 5.8 命令面板自测覆盖 Temp/第三方目录拼接、Zion 判定与减面档位判定。
- 真实机器上的跨版本覆盖安装、Windows 设置卸载场景未在本次发布中实机验证。
