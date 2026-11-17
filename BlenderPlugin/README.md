# AssetHive for Blender

在 AssetHive 的「偏好设置 → 导出」中选择 **Blender**，浏览到所用版本的 `blender.exe`，点击路径右侧的**下载图标**安装。已安装时显示绿勾，悬停显示重装图标；安装说明和结果可悬停在目标软件上查看。
插件从软件根目录的 `BlenderPlugin/assethive` 安装到 Blender 自己报告的用户 `scripts/addons/assethive` 目录，并启用及保存插件偏好。安装前已打开的 Blender 需要重启一次。

打开 Blender 后，3D 视图侧栏的 **AssetHive** 面板显示连接状态。AssetHive 左下角连接灯变绿，即可从详情或卡片发送资产。切换回 Unreal Engine 时保留原引擎 / 工程路径，两种软件的安装和连接各自独立。

Blender 路径也支持粘贴 `blender.exe` 的完整路径，回车或移出输入框后保存。开发预览若尚未重启主进程，浏览按钮可先选择包含 `blender.exe` 的安装文件夹，插件安装和连接需要完整重启 AssetHive 后生效。

- 支持 Blender 3.6 及以上；Windows 桌面端选择具体的 Blender 程序版本。
- 模型支持 FBX、OBJ、glTF / GLB、Alembic。ST9、ZTL 会显示格式不支持，不能直接发送。
- 导入原始模型变体和 PBR 材质，按贴图组与材质槽分配；植被使用原始模型，不运行 Unreal 的 Nanite 或合成风处理。
- 导入集合、对象与网格数据使用 `资产名_ID`（如 `Dark Fractured Boulders_bjhq30r`）；多个对象 / 模型变体附加 `_01`、`_02` 序号区分。
- `3D Assets` 仅发送 Basecolor、Roughness、Normal 三种独立贴图，不合图、不叠加 AO，也不发送金属度、位移或透明度。其他分类保留独立 PBR、ORM、ORDp / Mask、颜色加透明度、BCR 与 ORT 支持。
- `3D Assets` 可在 AssetHive 详情导出栏的立方体图标选择减面比例：`100%`（默认，不减面）、`75%`、`50%`、`25%`、`10%`，鼠标悬停图标可看到当前比例。插件以非破坏性 Decimate（Collapse）修改器减面，源模型、源网格与 UV 仍可编辑，导出时由 Blender 正常求值。
- 减面保持 UV 边界：所有 UV 接缝 / 边界顶点（包括没有标记 seam 的 UV 不连续边与非流形边）和材质分界顶点都被锁定，位置与每个 UV 层的坐标逐角不变，只塌陷内部顶点；多个 UV 层同时保持。UV 岛或材质分界很密时实际面数可能高于所选比例，减面按「尽量达到所选比例、边界不变」处理。
- 减面从插件 `1.0.2` 起提供。旧插件不支持减面，AssetHive 会在发送前提示重新安装插件；重新安装后请重启 Blender。选择 `100%` 时仍兼容旧插件。
- Basecolor 使用 sRGB；Roughness 与 Normal 使用 Non-Color，Normal 通过切线空间法线节点连接材质。按资产保存的 DX / OpenGL 标记处理：DX 在节点中反转绿色通道（G = 1 - G）以适配 Blender 的 OpenGL 法线，OpenGL 保持原样，不改写源文件。
- PNG、JPEG、WebP、TIFF 根据导出分辨率限制缩放；HDR / EXR 保留源分辨率。Windows 共享盘路径发送前统一为原生 UNC 格式，避免 Blender 把 `//` 路径误当作相对路径。
- Surface / Decal 创建带材质的平面；HDRI 设置当前场景的 World。Decal 使用透明平面，未实现 Unreal 的贴花投射。
- 连接仅监听本机 `127.0.0.1:13450–13459`，使用安装生成的本机令牌。所有 Blender 数据操作通过主线程计时器执行；收到逐项成功回执后才累计导出次数。连接中断后不自动重复发送，应先检查场景。

验证过 Blender 3.6.23 / 4.5.4 / 5.2.3 的中文节点名称环境，以及插件安装、共享盘 TCP 导入、三贴图与 DX / OpenGL 法线。减面五档比例、双 UV 层边界与材质分界保持已在 Blender 5.2.3 实测。安装时由 Blender 启动流程读取原有偏好，避免 3.6 在后台重新加载偏好导致崩溃，并保留现有设置。插件更新后重启 AssetHive，在设置中点击「重新安装」，再重启 Blender。开发回归可执行 `blender.exe --background --factory-startup --python-exit-code 1 --python scripts/test-blender-addon.py -- <输出目录> zh_HANS`（测试自动兼容 3.6 的 `zh_CN`，含减面比例、UV 边界与材质分界用例）。

图标来自 [Simple Icons](https://github.com/simple-icons/simple-icons) 的 Blender / Unreal Engine 图标（CC0）。
