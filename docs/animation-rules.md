---
title: 动画资产技术规格
summary: |
  Zion 角色动画制作与导入规范：资产前缀、AnimSequence 必须绑定 Skeleton、60 FPS、
  受击与停步 Root 位移、主角 Hero 目录步数与同步组。面向动画与 TA。
tags: [动画, AnimSequence, RootMotion, 同步组, 美术资产, UE5]
updated: 2026-11-20
status: draft
related_docs:
  - Docs/美术资产规格/资源命名规范.md
  - Docs/美术资产规格/资源目录规范.md
---

# 动画资产技术规格

## 1. 资产类型前缀

与 [资源命名规范](资源命名规范.md) 动画段对齐。允许 `A–Z` `a–z` `0–9` `_`。禁止空格、中文、特殊符号。逻辑名 PascalCase，多词用下划线分段。

| 前缀 | 类型 |
|------|------|
| `AS_` | 动画序列 AnimSequence |
| `BS_` | 混合空间 BlendSpace |
| `ABP_` | 动画蓝图 |
| `AM_` | 动画蒙太奇 |
| `AC_` | Animation Composite |
| `SK_` | 骨骼网格 Skeletal Mesh |
| `SKEL_` | 骨骼 Skeleton |
| `PHYS_` | 物理资产 Physics Asset |

## 2. AnimSequence 必须绑定 Skeleton

每条 `AS_` 的 **Skeleton 不能为空**。未指定 Skeleton 会在 Cook 报错。

- 导入时指定目标 Skeleton，按动画导入，不得当静态网格导入。
- 同角色（或同主角性别体）共用同一 `SKEL_`，不为单条动画另建孤立 Skeleton。

## 3. 导入帧率

所有动画按 **60 FPS** 导出并导入。不要用 30 导出再在引擎里拉伸。

AssetHive 导入检查优先读关键帧间隔；ASCII FBX 的 `TimeMode` 只作对照（9=NTSC 29.97，10=PAL 25）。场景 TimeMode 仍是 29.97/25 时，只要曲线是 60 帧就按 60 通过。

## 4. Root 位移

引擎单位：1 UU = 1 cm。`0.3m` = 30 UU。

| 对象 | 约束 |
|------|------|
| 受击（`Hit_*`） | Root 水平来回幅度不超过 **10cm**（整段最大 − 最小）。击飞 / 倒地为单向位移，不按本条 |
| 主角 WalkStop（`WalkStop*` / `LockWalkStop*`，含左右脚） | Root 位移 **= 0** |
| 主角 RunStop（`RunStop*` / `LockRunStop*`，含左右脚） | Root 位移 **= 0.3m**，方向与跑步前进一致 |

`SprintStop*`、下蹲停步不适用上表。

## 5. 主角步数

范围：归属为「主角」的动画，或归档在 `Animation/Hero/` 下的旧数据。「步」= 一次有效落脚。攻击 / 受击类型、Stop、非走跑循环、怪物 / NPC 不验步数，导入时会写明原因。

| 类别 | 判定 | 步数 |
|------|------|------|
| Start | 文件名含 `Start` | 3 |
| 循环 | 走跑循环（Walk / Run / Sprint / Crouch，不含 Start / Stop） | 4 |
| Stop | 含 `Stop` | 不验步数，Root 按 §4 |

## 6. Locomotion 同步组

`Locomotion/` 下所有动画必须配置同步组（Sync Group），包括 Start、循环、Stop，以及 BlendSpace 采样到的走跑条。

同一武器、同一移动族（Walk / Run / Sprint / CrouchWalk / CrouchRun）使用同一同步组。

## 7. 归档检查与怪物基础移动规范

维护数值及选项请修改 [`shared/animation-import-rules.json`](../shared/animation-import-rules.json)，重新构建后生效。规范检查使用归档 FBX，不要求连接或打开 UE。以下项目规范提取于 2026-11-20；这是有日期的规则快照，项目规则变更后需要同步，不会自动读取任意工程。

### 归档检查参数

- 名称保留资源真实大小写，使用 AS_ / BS_ / ABP_ / AM_ / AC_ 前缀，逻辑名 PascalCase，可用下划线及数字分段，禁止空格和中文。
- 导出帧率 60 FPS，容差 0.5 FPS；优先读取关键帧间隔，读不到时要求人工核对。
- 普通受击 Root 水平幅度不超过 10 cm（容差 0.5 cm）。主角 WalkStop 位移 0 cm（容差 1 cm），RunStop 位移 30 cm（容差 3 cm）；击飞、倒地、死亡、冲刺停和下蹲停不套用。
- 主角基础移动起步 3 步、循环 4 步；怪物、NPC、停步、攻击和受击不验固定步数。
- 基础移动规划标签可选；Alert=警戒、Idle=巡逻、Battle=战斗，Walk/Run/Stand=走/跑/站立（移动片段包含匹配，例如 WalkF=走，不读取角色名片段），Start/Stop=起步/停步，无阶段后缀默认循环。标签用于整理，不能代替数量及运动规范检查。战斗标签固定循环也不代表项目不允许特殊档战斗起停动画。

### 怪物基础移动：项目规则来源

源工程 `E:/Zion_MalinLine/Project`：

- `Plugins/GameFramework/ZionCharacterEditor/Source/ZionMonsterLocoCheckTool/Private/ZionMonsterLocoChecker.cpp`：九项判定及阈值。
- `Plugins/GameFramework/ZionCharacterEditor/Source/ZionAnimSetRefreshTool/Private/ZionAnimSetRefresher.cpp`：GetTagLeaf、IsExcludedFromCommonMonsterLoco。
- 同模块 `ZionMonsterLocoAnimSetApi.cpp`：Tag 与目录资源匹配。
- `Config/DefaultGameplayTags.ini`：AnimSet.MonsterLoco 叶子定义，已提取 34 项；redirect 与父级分组不计入模板。

检查器不依赖 MonsterAnimationSettings 表中的数值。Hive 不区分通用/特殊档，按所选动画适用的规则检查，34 个叶子 Tag 均可参与。源项目工具曾按通用/特殊分档，Hive 不继承这一筛选。待机与姿态转换仍参加命名、Root 旋转检查；移动方向排除 Stand 和 IdleTransition。

| 项目规则 | 判定口径 | 当前 Hive 详情 |
| --- | --- | --- |
| 停步初速度匹配循环 | 首个源帧窗口的平均速度与对应循环回归均速相差 ≤15% | 有配对 Loop 时本地检查；没有 Loop 时灰色标注初始速度暂不检查 |
| 停步 Distance 曲线 | 严格 `_Stop`，不含 StopShow；存在名为 Distance 的浮点曲线，且至少一关键帧 | 待核对：确认 UE 内曲线 |
| 起步匀加速 | 先匀加速再匀速；瞬变段 ≥0.1 s，位移偏差 ≤12%，源帧窗口速度偏差 ≤15% | 有 Loop 时固定循环均速；没有 Loop 时先拟合自身满速检查变速规律 |
| 停步匀减速 | 先匀减速再静止；同一起步阈值 | 有 Loop 时固定循环均速；没有 Loop 时先拟合自身入口满速检查变速规律 |
| 循环匀速 | Tag 字典存在对应 Start 或 Stop 时认定循环；全段每个重采样间隔的速度与全段回归均速偏差 ≤10% | 本地检查所选 FBX |
| Root 不旋转 | 相对首帧的最大四元数旋转角 ≤0.5° | 本地检查所选 FBX |
| 模板齐全 | 源项目按 Tag 模板检查整套资源；Hive 不设通用/特殊档 | 单动画详情与导入均不展示，后续在上层检查 |
| 命名后缀与 Tag 一致 | 严格大小写和下划线；Patrol 写作 Idle；IdleTransition.AlertToBattle 写作 Alert_To_Battle | 本地检查名称与规则快照 |
| 只沿移动方向位移 | 相对水平 PCA 最佳拟合直线侧漂 ≤1 cm；相对首帧竖直位移 ≤1 cm | 本地检查所选 FBX；坐标轴缺失时待核对 |
| Stand Root 不移动（新增） | 整段相对首帧的三维最大位移应为 0；0.01 cm 只吸收导出数值噪声 | 本地检查；包含中途移动又回到原位，固定初始位置偏移不算运动 |

本地结果仅代表源 FBX。未匹配 Tag、无法读取骨骼/帧率/坐标轴、未执行配对或整套检查时，显示“待核对”或“不适用”，不能汇总为整套通过。没有 Loop 不阻止检查自身匀加减速，但不能据此宣称速度衔接通过。怪物基础移动不使用主角的固定停步距离和步数限制。

### 运动算法与边界

项目和本地可复用的算法口径：

- 以 120 Hz 重采样，含首末帧，样本数至少 max(源关键帧数, 16)、至多 4096；源动画至少 3 帧。
- 使用参考骨架第一根骨骼的本地变换，不使用预览 Mesh 的场景变换、不把 pelvis 运动当作另一根静止 root 的运动。本地要求唯一的骨架根；动画独立 FBX 导出为 Null/Group 时，只接受具有自身动画轨道的明确 root 节点；歧义时待核对。
- 从 FBX GlobalSettings 读取 UpAxis，UnitScaleFactor 换算厘米；不假设所有文件都是 Y-up。无法确认 UpAxis 不判方向与速度通过。
- 水平轨迹 PCA 主方向朝净位移方向；直线度 `1 - λ2/λ1 ≥ 0.95` 时用有符号投影距离，否则用累计弧长。侧漂以穿过轨迹均值的拟合直线为基准。
- 位移跨度 <1 cm 表示无法进行速度检查，循环不能因此通过。循环均速使用全段距离/时间的最小二乘斜率，须为正；检查首末帧之间的每个重采样间隔，不以较长窗口平均掩盖短暂停顿或速度波动。
- 起步模型：`t < tb ? t²/(2tb) : t - tb/2`；停步模型：`t < tb ? t - t²/(2tb) : tb/2`，均乘对应循环均速。枚举 `tb`，最小化位移平方误差；最大位移偏差除以 `max(循环均速 × tb, 1 cm)`。速度按一个源帧窗口测量，不能用拟合初速度代替实测停步入口速度。
- 配对仅使用当前库里同一归档目录、同一角色和动作名、去掉 `_Start` / `_Stop` 后的 Loop FBX。切换动画或更新 Loop 内容指纹会刷新配对检查；不借用其他怪物或其他移动族的循环。有冲突记录或 Loop 读取失败时明确标注。
- 没有可用 Loop 时（Hive 新增）：同时拟合 `tb` 和满速 `Vmax = Σ(D × G) / Σ(G²)`，仍以最小位移平方误差选择模型，并使用同一 12%/15% 阈值及源帧速度窗口。全程匀速、突跳和非线性变速不能借缺少 Loop 通过匀加减速检查。静止 Root 或位移 <1 cm 的移动起停失败。缺少循环时仍检查自身变速；初始速度行显示灰色“未找到loop资源，暂不检查”。

UE 原检查器会拒绝 Additive，并按 abs(RateScale) 修正实际时长/速度。本地 FBX 不包含可靠的 UE Additive、RateScale、导入重定向、压缩及动画浮点曲线信息，因此不能证明 UE 内资源同样符合规范。需要检查引擎最终结果时，直接使用项目原有检查面板。

此次取消的是规范检查桥接；发送动画与已有 UE 版本核验仍保留各自连接流程。未修改项目原检查器的算法或阈值。

### 导入与详情共用检查（2026-11-20）

两处均调用 `src/ui/animationRuleEvaluation.ts` 的同一检查入口。规范检查仅用于提示，命名、帧率、Root 或速度未通过均不阻止单项或批量导入；必填项、文件与路径检查仍执行。导入按填写的归档目录查找同名 Loop；同批草稿包含 Loop 时优先检查准备归档的版本，不借用其他目录的动画。

显示精简：命名、帧率、Tag后缀、移动方向、初始速度与整体速度。通过使用现有绿色 √，失败使用现有橘色 ×，未执行使用灰色 ⊘；怪物仍检查 Root 旋转、Stand 静止和适用的 Distance 曲线。移除单动画模板齐全项。帧率来源保留在解析数据中，不再占用通过行的文字。


## 8. 名称默认值与步数坐标轴（2026-11-23）

主角基础移动只填写走跑、阶段，状态不显示、不生成动作标签；怪物保留状态。武器类别和怪物按名称中的身份片段匹配配置表，精确匹配优先，其次忽略大小写、常见前缀及包含匹配。Unarm 与 Unarmed 等别名兼容；同分歧义留空，用户手选优先。

步数从左右脚的世界高度落脚次数计算，垂直轴使用源 FBX 的 UpAxis（X/Y/Z），单位按 UnitScaleFactor 换算。不能读取有效坐标轴时标记待核对，不固定假设 Y 向上。Z-up 的 AS_Unarm01_M01_RunF 每脚 2 次落脚，总计 4 步；真实两步动画仍报告 2 步。
