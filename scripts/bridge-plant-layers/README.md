# Bridge 植被分层与 UV3 验收

LOD0 原面对应无法成立时，记录几何权重回退。Billboard 必须声明 `representation=billboard`、`layers=["Shared"]`；导入时保留贴图 UV0，清零 Branch1、Branch2、Ripple 权重，仅保留 Shared。识别优先使用 Bridge 对最终 LOD 的 Billboard 材质声明；旧的图集代理还需确认最终网格确已从整株三维几何缩成平面。部分下载的最后一个现有 LOD 不直接视作 Billboard。验收须区分“通道存在且数据有限”和“该级仍能保留逐叶运动”，不能仅以源 FBX 有 UV0 判断迁移成功。

Billboard 只随 `lod` 导出；显式 FBX LOD 模式关闭 Nanite，使用常规 LOD 链切换。`naniteMasked` 和 `opaque` 都不携带 Billboard 模型、材质或纹理。Opaque 缺少裁切模型的变体回退为 Nanite Masked，仅保留原始 LOD0。导出 Job 的 `modelLods[].materialRole=billboard`、`materialGroupId` 独立于合成风传递，Micro 也保留材质角色。UE 为 Billboard LOD 添加专用材质槽，绑定独立 `MI_Billboard_*`，继承同类别的 `MI_Env_Grass/Bush/Tree/Micro_Billboard_ST_VT` 父变体并使用 Billboard 纹理组；父变体从对应普通父实例复制。Grass/Bush/Tree 仅启用 `SharedEnable`，关闭 Branch1、Branch2、Ripple、Shimmer、UV3 分支解码及 `Interactive`；Micro 全部关闭，Shared 也不保留。子实例重导时同样强制这些开关，不能仅靠风动 UV 里的零权重隔离交互。

低 LOD 共用已核验的 LOD0 风层，不另拟枝轴。清单以 `lodWindMode=lod0-uv0-surface` 声明复用方式，在各变体的 `lodSources.LOD1...` 中保留实际源文件、SHA-256 和 `windSource=LOD0`；LOD 编号缺项时仍按原始文件验证。导出到目标 LOD 链时再记录实际目标槽位。导入器通过 UV0 与空间位置回查 LOD0 原面，保持该面的枝轴、方向和相位，插值其角点上的 Branch1、Branch2、Ripple 权重，再写入每个目标 LOD 自身的 UV1–UV3。离散打包值不作插值，UV3 重新编码为 Mode 2。UV0 保持原值，缺少的风动通道在每级网格上补齐；Micro 等静态导出仍保留源 UV。

`_layer.json` 使用 schema 1 表示原始 LOD0 的几何归属。UV3 模式 2 是导入时的逐顶点编码，不是清单版本。一级枝和二级枝使用已确认的父轴及附着位置；末端的 `blade` 按叶根到叶尖排列。没有二级枝的草叶也可以通过 UV2.g 使用 Ripple。Micro 为无风导出档，支持手选。海藻、睡莲、沉水草、散落枯叶以及较大的三叶草/酢浆草仍按有风植被建立分层，不按名称或水生分类强制无风。Auto 对可动第三方植被检查所有原始变体的尺寸，均不超过高 10 cm、横向跨度 60 cm 时使用 Micro。其他情况使用已核验分层清单中的 `form`，空字符串仅表示静态清单。托管子集保留原资产的尺寸汇总，避免小变体改变整项风型。旧清单缺少可识别的 `form` 时按资产分类与标签推断。

检查根部时，先在原始 LOD0 上沿高度取六个横截面，区分从地面连续向上生长的细茎和碰到地面的叶尖。前者应绑定到支撑它的枝轴。确有土面接触且基部权重仍超过 0.01 的绑定可以带可选的 `rootContact`：`center` 按 LOD0 包围盒逐轴归一化，`innerHeight`、`outerHeight` 均为半径除以植株高度。UE 在内圈将 Branch1、Branch2、Ripple 权重降到零，在外圈恢复原权重；Shared 由风材质控制。Opaque 裁切沿用原卡片角点的根部权重。不要按世界 Z 把所有低处叶尖固定。

新角点可能落在原三角形内部的固定根区，即使原三角形的三个角点均满足约束，插值仍可能抬升新角点的权重。Opaque 与低 LOD 在复用原面权重后，按同一 `rootContact` 将三层权重限制在当前位置根部包络以内。原始 LOD0 不增加衰减，根区外的复用结果不变；不能根据裁切碎片重新拟合枝轴或把相邻叶尖当作根部。

在仓库根目录生成目录清单，然后执行两种互补核验。Python 环境需提供 NumPy 和 SciPy；报告输出使用一个尚不存在的文件名。

```powershell
node scripts/bridge-plant-layers/catalog.cjs D:/BridgeLibrary/Downloaded/3dplant catalog.json
py -3.12 scripts/bridge-plant-layers/publish.py D:/BridgeLibrary/Downloaded/3dplant catalog.json --check-library
py -3.12 scripts/bridge-plant-layers/audit_geometry.py D:/BridgeLibrary/Downloaded/3dplant catalog.json geometry.jsonl --workers 2
```

第一步检查每个资产身份、原始 FBX 的 SHA-256、变体集合、JSON 重名键、分块次序与摘要、岛和父子轴的对应、叶轴、声明及汇总。发布暂存结果之前也走同一套校验。第二步实际解出每个 FBX，核对坐标框、岛中心和有无三角面，并按导入器的叶轴投影、SmoothStep 和 8 位量化计算端点覆盖。逐变体输出，发现不匹配或整组失效时返回非零。两者都不会改写库。

每个风单元可以横跨多个岛和分块。叶根碎片单独为零正常。检查包含 `rootContact` 的根部衰减，与 UE 写入 UV2.g、UV3 的顺序一致；生成器先建立根部衰减，再检查有效 Ripple。只有父轴、附着值和叶轴完全相同的整组在最大振幅下仍量化为零，生成器才会撤掉该组的 Ripple。已有方向、枝条归属和非末端运动不变。低振幅下只有一个码值的边界情形单独统计。

有些扫描支撑会沿相邻表面折返，原始路径很长但首尾几乎重合。仅当原网格两程在同一狭窄范围内重合时，使用真实折返点作轴梢，并把附着在原路径上的后代映射到新轴。对于走过不同枝杈的短轴，生成器沿实测枝段接点识别主枝延伸与侧枝，重算后代附着位置。主枝拆分后，再核对原有侧枝的枝根。生长在二级枝上的后代使用同一风轴，在实测接点固定附着值；长在共同基部的侧枝可以独立摆动。末端叶片保留各自的 Ripple。小型未绑定碎片只有在所有原始三角面一致贴合唯一支撑组织时，才继承该组织的风层。结构校验通过不代表每一个拟合的父枝都已得到植物学确认；`review=true` 的动态岛只保留 Shared。

补查附着点时使用有限三角面的真实距离，包含边界，不能仅找最近顶点或把三角面当作无限平面。两端都靠近支撑、同时接触不同父枝或成对叶面判断不一致时仍保留待确认。先恢复实测父茎，再处理其侧枝与叶片；宽铺地资产中通过六个截面确认的真实根茎同样可以建立一级轴。支撑长出后代后撤掉自身 Ripple。扫描碎片继承同一表面的根部衰减及各层风场，保留已有效的 `rootContact`，避免为小碎片重新拟合不同的衰减范围而产生拉伸。

封口细茎须通过六个闭合且不扁平的横截面，并在真实端部顶点处接触唯一已绑定支撑。主枝延续复用原轴；侧枝在实测接点建立二级轴；二级枝上的更深侧枝只继承接点处的父层运动。小叶按自身尺寸检查叶根，避免整株高度门槛漏掉花穗组织。最多 32 面的碎片仍须全体角点一致贴合唯一有限表面。

重复小型花叶组织以原始拓扑和点距形状匹配已确认组织；同资产其他变体只提供形状样本，当前变体的父枝仍须由自身真实接点或至少三个原始锚定组织共同证明。仅补回可确认的 Branch1/Branch2，不新增 Ripple。接缝传播须有两侧各至少两个真实近邻顶点、相容法线和连续路径；竞争风场、跨越待确认岛或过长路径均拒绝。支撑及复制其风场的碎片同步关闭支撑 Ripple。

UE 先按原始 0.0001 cm 量化格还原岛。FBX 双精度坐标转为单精度后发生跨格拆岛时，仅尝试 0.0001/0.0002 cm 补焊，要求精确恢复声明岛数，并再次检查逐岛中心误差；烘焙 LOD0 重放同一分区。数量、分块覆盖或逐岛几何不符仍拒绝导入。
