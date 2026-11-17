# AssetHive 2.2.8

Windows x64。

## 本次更新

- **Surface 导出补齐 AO**：固定导出 `BCR`、`N`、`AO`、`Dis`；AO 来源优先级为「独立 AO 贴图 → ORM 的 R 通道 → 纯白兜底纹理（AO=1.0）」，因此 Surface 永远会带 AO。
- **Surface 的 Metallic 改为按需导出**：源贴图不存在、或像素纯 0（全黑）时不导出 `M` 槽位；`E`（Emissive）不再固定导出。
- **插件支持 AO 参数槽位**：新增设置项 `SurfaceAOParameter`（默认 `AO_VT`），Surface 材质实例会把 AO 贴图绑到该参数；AO 按 `TC_Masks` + 线性（sRGB 关闭）导入，2K 档、≥2K 开 VT。
- **Fuzz 永不导出**：导出槽位白名单移除 fuzz，3D Assets / 3D Plants 的导入白名单同步移除，任何资产类型都不会再出现 Fuzz 贴图。
- **Decal / 3D Plants 基础色按来源叫法命名**：源贴图叫 Diffuse/BaseColor 导出 `_D`，叫 Albedo 导出 `_AL`；Decal 不再使用 `BCR`。

## 安装包

- `AssetHive-2.2.8-setup-win64.exe`：独立安装程序，推荐使用。
- `AssetHive-2.2.8-Windows.msi`：供 BlackBlade Hub / 静默部署使用。
- `AssetHive-2.2.8-Windows-setup.exe`：深色安装界面，内部安装同一份 MSI。
- 每个安装包均提供 `.sha256` 校验文件。

## 验证边界

- Node 侧：`typecheck` 通过；`test-image-processing`（Surface 槽位/ORM 拆 AO/纯白 AO 兜底/Metallic 全 0 不导出/Fuzz 永不导出/Decal 命名）与 `test-export-category-folder` 全部通过。
- 插件侧：自测覆盖 Surface AO 绑定参数、槽位白名单；C++ 侧未在本机编译，需在构建机上验证。
- 真实机器上的跨版本覆盖安装、Windows 设置卸载场景未在本次发布中实机验证。
