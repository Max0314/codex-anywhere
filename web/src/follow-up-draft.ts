import type { TimelineItem } from './history-utils';

// Offer the next step the assistant actually named in its latest reply.
export function followUpDraft(items: TimelineItem[]) {
  let index = items.length - 1;
  while (index >= 0 && items[index].kind !== 'assistant' && items[index].kind !== 'user') index--;
  const last = items[index];
  if (last?.kind !== 'assistant' || last.questions?.length) return '';
  const text = last.text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/\*\*/g, '');
  const match = [...text.matchAll(/(?:下一步(?:建议|可以|是)?|接下来(?:建议|可以)?|我(?:建议|可以继续)|如果你愿意[，, ]*我可以)[：:，,、\s]*([^。！？?\n]{3,200})/g)].at(-1);
  if (match) return '请' + match[1].trim().replace(/^(?:我(?:会|可以)|可以|请|建议|先)\s*/, '') + '。';
  const english = [...text.matchAll(/(?:next step(?: is to)?|next,? (?:I can|we can)|I (?:can|recommend))[:\s]+([^.!?\n]{5,200})/gi)].at(-1);
  return english ? 'Please ' + english[1].trim().replace(/^to /i, '') + '.' : '';
}
