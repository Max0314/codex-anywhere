import type { TimelineItem } from './history-utils';

export function hiddenInternalContext(item: Pick<TimelineItem, 'kind' | 'text' | 'attachment' | 'visualization'>) {
  return item.kind === 'user' && !item.attachment && !item.visualization
    && /^<codex_internal_context\s+source="goal">[\s\S]*<\/codex_internal_context>$/.test(item.text.trim());
}
