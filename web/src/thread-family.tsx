import { useEffect, useState } from 'react';
import type { BridgeRequest } from './bridge-request-manager';
import type { Session } from './app-types';
import { t } from './i18n';

type Family = { parent: Session | null; children: Session[] };

export function useThreadFamily(id: string | null, environment: string, request: BridgeRequest, running: boolean) {
  const key = environment + ':' + id;
  const [result, setResult] = useState<{ key: string; family: Family | null }>();
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await request<Family | null>('session.family', { threadId: id }, { signal: controller.signal });
        if (!controller.signal.aborted) setResult({ key, family: next });
      } catch { /* History remains usable when Desktop has no family metadata. */ }
      if (running && !controller.signal.aborted) timer = setTimeout(() => void refresh(), 12000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, key, request, running]);
  return result?.key === key ? result.family : null;
}

export function ThreadFamily({ family, onSelect }: { family: Family | null; onSelect: (session: Session) => void }) {
  if (!family || (!family.parent && !family.children.length)) return null;
  return <nav className="thread-family" aria-label={t('关联会话', 'Related sessions')}>
    {family.parent && <button type="button" onClick={() => onSelect(family.parent!)}>← {t('主会话', 'Parent')} · {family.parent.title}</button>}
    {family.children.length > 0 && <details><summary>{t('子 Agent', 'Subagents')} · {family.children.length}</summary>
      {family.children.map(child => <button type="button" key={child.id} onClick={() => onSelect(child)}>{child.title} ›</button>)}
    </details>}
  </nav>;
}
