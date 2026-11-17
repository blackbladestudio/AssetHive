// Merge completion into the live editor, never into the submit-time snapshot.
// The stable queue ID survives tab changes, edits and insertion of split weapons.
export function finishCharacterImportTasks(drafts, current, completedIds, appended = []) {
  const completed = new Set(completedIds);
  const live = drafts.map(draft => draft.form.queueId === current.form.queueId ? current : draft);
  const remaining = [...live, ...appended].filter(draft => !completed.has(draft.form.queueId));
  const activeIndex = Math.max(0, remaining.findIndex(draft => draft.form.queueId === current.form.queueId));
  return { drafts: remaining, activeIndex };
}
