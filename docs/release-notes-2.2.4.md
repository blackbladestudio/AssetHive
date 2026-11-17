# AssetHive 2.2.4

Windows x64。

## 本次更新

- 导入面板多选时，资产名、分类、标准 Asset Tag、动画选项、归档目录及裁切参数值不一致会显示 `Multiple Value`；输入或选择新值后统一应用到所选资产，保留未修改字段和各资产文件。
- 支持将混合资产类型统一切换为新类型，再设置分类；修复批量修改误改未选中的当前资产，以及混合归档目录失焦后被重置的问题。
- 精简左下角状态栏：扫描显示简短状态与百分比，批量导入显示已处理数 / 总数；详细信息可悬停查看。
- 控制台入口移至偏好设置「通用 → 控制台」。
- 导出设置保留目标路径与插件自动检测，检测成功显示绿勾，移除插件安装与重装入口。
- 应用更新源切换至本仓库的 Releases。
- 同步最新源码中的导出标签修复，避免将资产类型和分类派生词重复作为普通标签发送给 UE。

## 安装包

- `AssetHive-2.2.4-setup-win64.exe`：独立安装程序。
- `AssetHive-2.2.4-Windows.msi`：供 BlackBlade Hub / 静默部署使用。
- `AssetHive-2.2.4-Windows-setup.exe`：深色安装界面，内部安装同一份 MSI。
- 每个安装包均提供 `.sha256` 校验文件。

源码同步至 [Biscuits-Lab/Assethive_Sourcecode](https://github.com/Biscuits-Lab/Assethive_Sourcecode) 的 `BlackBlade_Main` 分支。

## 已知问题

本机 UE 插件源码与 AssetHive 的植被 OPAQUE 裁切预算仍不一致：AssetHive 的 Bush / Grass 预算为 30 万 / 15 万面，插件当前仍按 3.5 万 / 1 万面处理。对应的跨仓库一致性回归测试尚未通过；实际影响取决于所使用的插件版本。本次仅发布桌面端更新，未变更 UE 插件。
