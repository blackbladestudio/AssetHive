// Keep technical diagnostics intact; put an actionable explanation above them.
export function characterSendGuidance(message = '', t = zh => zh) {
  const text = String(message);
  const rule = (owner, title, titleEn, next, nextEn) => ({ owner, title: t(title, titleEn), next: t(next, nextEn) });
  if (/正在处理另一个导入任务|another.*import.*(?:busy|running)/i.test(text))
    return rule('artist', 'UE 正在处理另一批资源', 'UE is processing another batch', '等当前任务完成，再点击“重新检查”。', 'Wait for the current task, then click Recheck.');
  if (/工程.*不一致|连接.*所选目标|not connected|ECONNREFUSED|未连接|没有.*编辑器/i.test(text))
    return rule('artist', '尚未连接到目标 UE 工程', 'The target UE project is not connected', '打开要接收资源的 UE 工程，在“目标工程”中选中它，再重新检查。', 'Open the receiving UE project, select it under Project, then recheck.');
  if (/请.*更新.*插件|请编译|插件.*不支持|Unsupported.*protocol/i.test(text))
    return rule('ta', '请联系 TA 更新 UE 插件', 'Ask your TA to update the UE plugin', '把诊断信息发给 TA。更新完成后，保存并重启 UE，再重新检查。', 'Send the diagnostic details to your TA. After the update, save and restart UE, then recheck.');
  if (/检查后.*变化|文件.*已变化|资源.*已变化|内容变化|重新检查影响范围|检查已失效/.test(text))
    return rule('artist', '资源在检查后发生了变化', 'Resources changed after inspection', '点击“重新检查”，核对新的变化及影响范围后再发送。', 'Click Recheck and review the new changes and affected assets before sending.');
  if (/无法确定材质类型|请选择衣服或皮肤/.test(text))
    return rule('artist', '请确认这组材质是衣服还是皮肤', 'Choose clothing or skin for this material group', '在“发送到 Unreal Engine”的材质类型中选择“衣服”或“皮肤”，再重新检查。无需修改模型或重新绑定。', 'Choose Clothing or Skin under Material type in Send to Unreal Engine, then recheck. No mesh or rig change is needed.');
  if (/请指定有效的已有 Skeleton/.test(text))
    return rule('rigger', '需要确认这个 SK 使用的骨架', 'Confirm the skeleton for this SK', '请绑定师提供这个模型配套的 UE 骨架，在骨架选项中选择它后重新检查；若工程里还没有，请联系 TA 接入。', 'Ask the rigger for the matching UE skeleton, select it in Skeleton options and recheck. If it is missing from the project, ask your TA to add it.');
  if (/物理资产未生成.*骨骼和尺寸/.test(text))
    return rule('rigger', '这个模型没有生成碰撞身体', 'Collision bodies could not be generated for this mesh', '请绑定师检查模型的单位、尺寸和骨骼，重新导出并上传 SK；如果源文件正确，请联系 TA 检查 UE 物理资产生成。', 'Ask the rigger to check units, mesh scale and bones, then export and upload the SK again. If the source is correct, ask your TA to check UE physics asset generation.');
  if (/没有可导入的蒙皮|骨骼名称.*重名|骨骼.*层级.*不兼容|骨架层级不兼容|同名骨骼.*不同父级|骨架与模型不兼容/.test(text))
    return rule('rigger', '请绑定师检查这个 SK', 'Ask the rigger to check this SK', '把模型名和诊断信息发给绑定师，核对目标骨架、骨名、父子关系和蒙皮；重新导出 FBX，上传绑定文件后再发送。', 'Send the mesh name and diagnostics to the rigger. Check the target skeleton, bone names, hierarchy and skin weights, then export FBX, upload the rig and send again.');
  if (/等待新版骨骼模型|SM LOD1 与当前 SK LOD0 不匹配/.test(text))
    return rule('rigger', '需要与新版美术模型配套的 SK', 'A rig matching the updated art mesh is needed', '请绑定师用新版美术模型完成绑定并上传 SK，再从 AssetHive 发送。静态模型可继续使用。', 'Ask the rigger to rig the updated art mesh and upload the SK, then send from AssetHive. The static mesh remains usable.');
  if (/材质槽待指定|材质槽无法匹配/.test(text))
    return rule('artist', '这个模型还有材质没有对应上', 'Some mesh slots need a material', '在“这些模型还没有找到对应材质”中选择已有材质；临时颜色模型可选 Blockout。若配套美术模型已有正确材质却仍不能匹配，请联系 TA。', 'Choose an existing material in the material matching section, or use Blockout for temporary colors. If the paired art mesh already has correct materials but matching still fails, ask your TA.');
  if (/法线格式/.test(text))
    return rule('artist', '请确认法线贴图格式', 'Confirm the normal map format', '按贴图导出时的设置，在“导入设置”选择 DirectX 或 OpenGL，再重新检查；不确定时询问贴图制作者。', 'Choose DirectX or OpenGL under Import settings to match the texture export, then recheck. Ask the texture artist if unsure.');
  if (/待指定贴图类型|同材质组贴图类型重复/.test(text))
    return rule('artist', '请整理这组贴图的用途', 'Check the texture roles in this group', '打开“编辑资产”，确认每张贴图的类型和所属材质组，处理重复项后重新检查。', 'Open Edit asset, check each texture type and material group, resolve duplicates, then recheck.');
  if (/Managed source missing|ENOENT|管理目录|源文件.*缺失/i.test(text))
    return rule('artist', '资产文件暂时无法读取', 'An asset file cannot be read', '先确认资产库连接正常；若文件确实缺失，用更新资源补回原文件后重新检查。不要在 UE 中手动替换为其他文件。', 'Check the library connection. If the file is missing, restore it through Update resources and recheck.');
  if (/必要依赖未完成|依赖.*尚未核验/.test(text))
    return rule('artist', '它需要的材质或贴图还没完成', 'A required material or texture is not ready', '先处理本次列表中材质或贴图的提示，再重新检查并发送。', 'Resolve the material or texture issues in this list, then recheck and send.');
  if (/UE 材质已手调|已有手动材质/.test(text))
    return rule('artist', 'UE 里的材质有手动修改', 'The UE material was edited manually', '确认要保留 UE 设置，还是采用本次外观；不确定修改用途时请联系 TA。', 'Choose whether to keep the UE settings or use this appearance. Ask your TA if the purpose of the edits is unclear.');
  if (/版本控制|签出|save failed|保存失败|写入权限|只读/i.test(text))
    return rule('ta', '请联系 TA 检查资源写入权限', 'Ask your TA to check write access', '发送模型名和诊断信息，请 TA 检查版本控制登录、文件占用和签出权限；处理后重新检查。', 'Send the asset name and diagnostics to your TA to check source control login, file locks and checkout permissions, then recheck.');
  if (/母材质|模板|采样|ShadingMask.*参数|贴图绑定未生效/.test(text))
    return rule('ta', '请联系 TA 检查项目材质', 'Ask your TA to check the project material', '把材质名和诊断信息发给 TA，检查母材质、贴图参数及 VT 采样兼容；处理后重新检查。', 'Send the material name and diagnostics to your TA to check the master material, texture parameters and VT sampling, then recheck.');
  if (/属于另一个|目标.*占用|相同来源身份|多个.*归属|多个可能对应|多个已关联对象|两个库资源指向/.test(text))
    return rule('ta', '请联系 TA 确认 UE 资源归属', 'Ask your TA to verify UE resource ownership', '发送资源名和引擎位置，请 TA 确认应关联哪个对象；不要为绕过提示删除或改名现有资源。', 'Send the asset name and UE location to your TA to identify the correct object. Do not delete or rename assets to bypass this message.');
  return rule('ta', '这项未完成，请联系 TA', 'This item is incomplete; contact your TA', '复制诊断信息并附上资源名，请 TA 检查原因后再重新检查。', 'Copy the diagnostic details with the asset name for your TA, then recheck after the cause is resolved.');
}
