AssetHive 2.2.3 Windows x64。

已通过豆包严格测试。

## 本次更新

### 植被不透明裁切

- 不透明裁切（Trace 路线）按 Houdini HDA `sop_XJP.TA.GrassMaskedToOpaque` 的链路重写：逐源三角形求 0.5 等值线并裁剪，边界即等值线本身，取代原先"格心在遮罩内就整格保留"的台阶状边界。
- 新增均匀四分加密与薄壳单层化：同一 20 万面预算下轮廓重合度由 94.3% 提升到 96.9%，正反重合对由 23.13% 降到 0.00%。
- 修复裁切产物顶点法线、顶点色、第二套 UV 全部为零的问题（此前转移查找表建在待填充面片上，等于自己查自己）。顶点法线与面法线偏差由 90°（退化）回到 13.4°。
- 生成面片数直接决定内存峰值：worker 堆设为 6GB、生成上限 500 万，避免默认 4GB 上限下的必然 OOM，默认细分档由 4 调整为 6。

### 导出目录与植被分类

- 修复 Megascans / PBRMAX 资产被导到 `Environment/Asset/3D_Assets` 而不是 `Objects` 的问题：凡插件能按 Asset Tag 推导目录的资产，导出侧一律传空串，不再按 Asset Type 覆盖插件的正确结果。
- 导出侧为植被补发 `plantCategory` 字段（取元数据 category），插件据此落在 `Vegetation/Bush`（灌木）或 `Vegetation/Grass`（其余），目录映射权威保持在插件侧。
- 对齐 Zion 目录与 Asset Tag 推导的基础分类目录。

### 其他

- 移除 Normal 贴图格式的自动检测。

## 安装包

- AssetHive-2.2.3-Windows.msi / .sha256：BlackBlade Hub 兼容的整机安装包，目录为 Program Files\AssetHive，安装可能需要管理员权限和 Windows UAC 确认。
- AssetHive-2.2.3-setup-win64.exe / .sha256：独立安装，或由 Hub 安装。

两个安装包均提供 SHA-256 校验文件，请按对应文件名验证后再安装。本次发布提供安装包；本仓库源代码尚未同步到 2.2.3。
