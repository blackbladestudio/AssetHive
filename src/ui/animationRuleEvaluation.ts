import { evaluateAnimationImportRules, getAnimationRuleName, type AnimationRuleInput, type AnimationFbxStats } from './animationRules';
import { evaluateMonsterRules, findMonsterLoop, type MonsterLoopReference } from './animationMonsterRules';
import type { AssetRecord } from '../types';

// Import validation and the detail panel must use exactly the same rule set.
export function evaluateUnifiedAnimationRules(input: AnimationRuleInput, reference: MonsterLoopReference = {}) {
  const general = evaluateAnimationImportRules(input);
  if (input.animationAffiliation !== '怪物' || input.animationType !== '基础移动') return general;
  return [...general.filter(check => check.id === 'name' || check.id === 'fps'), ...evaluateMonsterRules(getAnimationRuleName(input.assetName, input.filePath), input.stats || null, reference)];
}

export type AnimationRuleDraft = { sourcePath: string; destinationPath: string };
export async function loadAnimationRuleReference(filePath: string, destinationPath: string, assets: AssetRecord[], drafts: AnimationRuleDraft[], loadStats: (file: string, skeleton?: string, revision?: string) => Promise<AnimationFbxStats>): Promise<MonsterLoopReference> {
  const filename = filePath.replaceAll('\\', '/').split('/').at(-1) || '';
  const plannedPath = destinationPath ? `${destinationPath.replace(/[\\/]+$/, '')}/${filename}` : filePath;
  const pair = findMonsterLoop(plannedPath, assets);
  if (!/_(Start|Stop)\.fbx$/i.test(filename)) return {};
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const loopFilename = filename.replace(/_(Start|Stop)(\.fbx)$/i, '$2');
  const candidates = [...new Set(drafts.filter(draft => normalize(draft.destinationPath) === normalize(destinationPath) && normalize(draft.sourcePath).split('/').at(-1) === loopFilename.toLowerCase()).map(draft => draft.sourcePath))];
  if (candidates.length > 1) return { name: pair.name, error: 'ambiguous' };
  // A staged update is the version that will be archived by this import.
  const source = candidates[0] || pair.filePath;
  if (!source) return { name: pair.name, error: pair.error };
  try { return { name: pair.name, stats: await loadStats(source, '', candidates.length ? '' : pair.revision) }; }
  catch { return { name: pair.name }; }
}
