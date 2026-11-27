import { createContext, useContext, useState } from 'react';
import type { Session } from './app-types';

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: Record<string, string> };
};
const directive = /::created-thread\{threadId="([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"\}/gi;
const markerPrefix = '::created-thread{threadId="';
function withoutPartialMarker(text: string) {
  const start = text.lastIndexOf('::');
  if (start < 0) return text;
  const ending = text.slice(start);
  return markerPrefix.startsWith(ending) || /^::created-thread\{threadId="[0-9a-f-]*"?$/i.test(ending)
    ? text.slice(0, start) : text;
}
const literal = new Set(['code', 'inlineCode', 'blockquote', 'link', 'linkReference', 'html']);

export function remarkThreadReferences(streaming: boolean) {
  return () => (tree: MarkdownNode) => {
    const ids = new Set<string>();
    function visit(node: MarkdownNode) {
      if (literal.has(node.type)) return;
      if (node.type === 'text' && node.value) {
        node.value = node.value.replace(directive, (_, id: string) => {
          ids.add(id.toLowerCase());
          return '';
        });
        if (streaming) node.value = withoutPartialMarker(node.value);
        return;
      }
      if (!node.children) return;
      for (const child of node.children) visit(child);
      node.children = node.children.filter(child => !(child.type === 'paragraph' &&
        child.children?.every(part => part.type === 'text' && !part.value?.trim())));
    }
    visit(tree);
    if (ids.size) tree.children?.push({ type: 'threadReferences', data: { hName: 'aside',
      hProperties: { 'data-thread-references': [...ids].join(',') } }, children: [] });
  };
}

export const ThreadReferenceContext = createContext<{
  childIds: ReadonlySet<string>;
  sessions: Session[];
  open: (id: string) => Promise<void>;
} | null>(null);

export function ThreadReferences({ ids }: { ids: string }) {
  const reference = useContext(ThreadReferenceContext);
  const [pending, setPending] = useState('');
  const [failure, setFailure] = useState('');
  const visible = ids.split(',').filter(id => !reference?.childIds.has(id));
  if (!visible.length) return null;
  const render = (id: string) => {
    const title = reference?.sessions.find(session => session.id.toLowerCase() === id)?.title;
    return <div key={id}>
      <button type="button" title={title || undefined} disabled={!reference || Boolean(pending)} onClick={() => {
        if (!reference || pending) return;
        setPending(id); setFailure('');
        void reference.open(id).catch(() => setFailure(id)).finally(() => setPending(''));
      }}>{pending === id ? '正在打开…' : title || '查看已创建会话'} <span aria-hidden="true">›</span></button>
      {failure === id && <small role="status">关联会话暂不可用，可重新尝试。</small>}
    </div>;
  };
  return <div className="thread-references">{visible.length === 1 ? render(visible[0])
    : <details><summary>已创建 {visible.length} 个会话</summary>{visible.map(render)}</details>}</div>;
}
