// Probe only the already supported, read-only status phase. Never send an
// unknown phase to an old plugin, whose legacy dispatcher could treat it as apply.
async function hasCharacterCapability(client, editor, capability) {
  if (!editor) return false;
  if (editor.capabilities?.includes(capability)) return true;
  if (!editor.capabilities?.includes('characterSuitV1')) return false;
  const response = await client.importAssets({ characterSuit: { version: 1, phase: 'status', suits: [], capabilityProbe: true } }, { projectPath: editor.projectPath });
  return response.suitResult?.capabilities?.includes(capability) === true;
}
module.exports = { hasCharacterCapability };
