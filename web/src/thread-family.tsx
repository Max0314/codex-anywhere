import { useEffect, useState } from 'react';
import type { BridgeRequest } from './bridge-request-manager';
import type { Session } from './app-types';
import { t } from './i18n';

export function ThreadFamily({ id, request, onSelect, running }: {
  id: string; request: BridgeRequest; onSelect: (session: Session) => void; running: boolean;
}) {
  const [family, setFamily] = useState<{ parent: Session | null; children: Session[] } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await request<typeof family>('session.family', { threadId: id }, { signal: controller.signal });
        if (!controller.signal.aborted) setFamily(next);
      } catch { /* History remains usable when Desktop has no family metadata. */ }
      if (running && !controller.signal.aborted) timer = setTimeout(() => void refresh(), 12000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, request, running]);
  if (!family || (!family.parent && !family.children.length)) return null;
  return <nav className="thread-family" aria-label={t('关联会话', 'Related sessions')}>
    {family.parent && <button type="button" onClick={() => onSelect(family.parent!)}>← {t('主会话', 'Parent')} · {family.parent.title}</button>}
    {family.children.length > 0 && <details><summary>{t('子 Agent', 'Subagents')} · {family.children.length}</summary>
      {family.children.map(child => <button type="button" key={child.id} onClick={() => onSelect(child)}>{child.title} ›</button>)}
    </details>}
  </nav>;
}
