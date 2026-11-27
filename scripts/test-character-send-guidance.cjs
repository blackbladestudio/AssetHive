const { test } = require('node:test');
const assert = require('node:assert/strict');

test('send guidance assigns art, rig and project problems to the appropriate person', async () => {
  const { characterSendGuidance: guidance } = await import('../shared/characterSendGuidance.mjs');
  const cases = [
    ['FBX 骨骼名称/父子层级与目标 Skeleton 不兼容：root', 'rigger', '重新导出 FBX'],
    ['文件有骨骼但没有可导入的蒙皮模型：SK_Test', 'rigger', '上传绑定'],
    ['等待新版骨骼模型：SM LOD1 与当前 SK LOD0 不匹配', 'rigger', '新版美术模型'],
    ['请确认法线格式 DirectX / OpenGL', 'artist', '贴图导出'],
    ['无法确定材质类型，请选择衣服或皮肤', 'artist', '材质类型'],
    ['请指定有效的已有 Skeleton；此 SK 暂不导入', 'rigger', '骨架选项'],
    ['武器物理资产未生成，请检查模型骨骼和尺寸', 'rigger', '单位'],
    ['同材质组贴图类型重复：body/D', 'artist', '编辑资产'],
    ['UE 状态在检查后变化，请重新检查', 'artist', '重新检查'],
    ['当前母材质不支持 ShadingMask 参数', 'ta', 'VT'],
    ['请更新 AssetHive UE 插件', 'ta', '重启 UE'],
    ['UE asset save failed: /Game/Test', 'ta', '签出权限'],
    ['此目标属于另一个库资产，不能覆盖', 'ta', '归属'],
    ['Unknown native failure', 'ta', '诊断信息'],
  ];
  for (const [message, owner, content] of cases) {
    const help = guidance(message);
    assert.equal(help.owner, owner, message);
    assert.match(help.title + help.next, new RegExp(content), message);
    const english = guidance(message, (_, en) => en);
    assert.ok(english.title && english.next);
  }
});
