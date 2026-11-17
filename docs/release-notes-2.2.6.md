# AssetHive 2.2.6

Windows x64。

## 本次更新

- 改进导入与编辑预览图的 Ctrl+V 粘贴，兼容 Electron 原生剪贴板，并防止切换资产后应用迟到的读取结果。
- 批量导入侧栏按可见范围加载缩略图，降低批量去背景时的内存占用。
- 统一 Opacity 贴图类型，兼容旧 OpacityMask / OpacityMasked；调整贴图类型菜单排序，切换资产类型不再补回已删除的可选 ORM 槽位。
- 支持多选导入草稿批量设置法线 DX / OpenGL 格式。
- Surface / Decal 导出使用平铺目录；Surface 与 POM Decal 高度贴图统一使用 _Dis，Surface 高度贴图尺寸跟随 2K / 4K 导出档位。
- 增加启动失败恢复、重复启动与退出保护，启动日志记录版本号。
- 修复打包时更新辅助程序中文源码的编码问题；MSI 内置禁止自动重启配置。

## 安装包

- `AssetHive-2.2.6-setup-win64.exe`：独立安装程序，推荐使用。
- `AssetHive-2.2.6-Windows.msi`：供 BlackBlade Hub / 静默部署使用。
- `AssetHive-2.2.6-Windows-setup.exe`：深色安装界面，内部安装同一份 MSI。
- 每个安装包均提供 `.sha256` 校验文件。

## 验证边界

导入回归 311/311、更新/扫描/预览/日志检查 57/57、类型检查、lint、构建、图像处理和 Windows 更新辅助程序检查通过。打包内容版本、代码及 Sharp/WebP 运行检查通过。

Electron 综合界面检查在 HDRI 封面加载等待处连续两次未通过；此前的剪贴板、卡片操作、缓存及预览替换检查通过，HDRI 项及其后续检查未确认通过。

真实机器上的跨版本覆盖安装、Windows 设置卸载及共享盘场景未在本次发布中实机验证。
