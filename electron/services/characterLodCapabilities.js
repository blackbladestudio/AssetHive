const REDUCTION_CAPABILITY = 'characterLodTargets40_15_10_2';

// Reduction is native code: a Python capability probe cannot prove the loaded DLL supports it.
function requireCharacterLodCapabilities(suits, capabilities = []) {
  const entries = suits.flatMap(suit => suit.entries || []);
  if (entries.some(entry => entry.config?.lodReductionProfile === 'targets-40-15-10-2')
    && !capabilities.includes(REDUCTION_CAPABILITY)) {
    throw new Error('请更新 AssetHive UE 插件并重启引擎，再重新检查。当前引擎尚未加载新的 LOD 减面规则，本次未发送资源。');
  }
}

module.exports = { REDUCTION_CAPABILITY, requireCharacterLodCapabilities };
