import { useEffect, useRef, useState } from 'react';
import type { BridgeRequest } from './bridge-request-manager';
import type { ExecutionState } from './app-types';
import { presenceLabel } from './app-utils';

export function quotaWindows(value: any) {
  const buckets = value?.rateLimitsByLimitId && Object.keys(value.rateLimitsByLimitId).length
    ? Object.entries(value.rateLimitsByLimitId) : value?.rateLimits ? [[value.rateLimits.limitId || 'codex',value.rateLimits]] : [];
  return buckets.flatMap(([limitId, bucket]: any) => ['primary', 'secondary'].flatMap(key => {
    const window = bucket?.[key];
    if (!Number.isFinite(window?.usedPercent) || !Number.isFinite(window?.windowDurationMins) || window.windowDurationMins <= 0) return [];
    const minutes = window.windowDurationMins;
    const label = minutes === 10080 ? '本周' : minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
    return [{ limitId, label: `${bucket.limitName || (limitId === 'codex' ? 'Codex' : limitId)} · ${label}`, remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)), resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null }];
  }));
}

export function AccountQuota({ environmentId, online, executionState, statusText, request }: {
  environmentId: string; online: boolean; executionState: ExecutionState; statusText: string; request: BridgeRequest;
}) {
  const [value, setValue] = useState<{ environment: string; windows: ReturnType<typeof quotaWindows> } | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let valid = true, pending = false;
    setValue(null); setOpen(false);
    const read = async () => {
      if (!online || pending) return;
      pending = true; setLoading(true);
      try {
        const result = await request('account.rate-limits.read', {}, { timeoutMs: 12000 });
        if (valid) setValue({ environment: environmentId, windows: quotaWindows(result) });
      } catch { if (valid) setValue({ environment: environmentId, windows: [] }); }
      finally { pending = false; if (valid) setLoading(false); }
    };
    refresh.current = () => void read();
    void read();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void read(); }, 60000);
    const foreground = () => { if (document.visibilityState === 'visible') void read(); };
    document.addEventListener('visibilitychange', foreground);
    return () => { valid = false; clearInterval(timer); document.removeEventListener('visibilitychange', foreground); };
  }, [environmentId, online, request]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const windows = online && value?.environment === environmentId ? value.windows : [];
  const summary = windows.filter(window => window.limitId === 'codex');
  const current = summary;
  const state = presenceLabel(online, executionState, statusText);
  return <div className="account-quota" ref={root}>
    <button className={`quota-summary presence ${online ? 'online' : 'offline'} ${online ? executionState : ''}`} type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`剩余额度 · ${state}`} title={state}>
      <svg className="presence-context-ring" viewBox="0 0 30 30" aria-hidden="true"><circle className="presence-context-track" cx="15" cy="15" r="12.5" pathLength="100" /></svg>
      <i aria-hidden="true" />
      <strong>{!online ? '—' : current.length ? `${Math.round(Math.min(...current.map(window => window.remaining)))}%` : loading ? '…' : '—'}</strong>
    </button>
    {open && <section className="quota-popover"><header><strong>Codex 剩余额度</strong><span>{state}</span></header>
      {windows.length ? windows.map((window, index) => <div className="quota-window" key={index}><span>{window.label}</span><strong>{Math.round(window.remaining)}%</strong><progress max="100" value={window.remaining} />{window.resetsAt && <small>{new Date(window.resetsAt * 1000).toLocaleString()} 重置</small>}</div>) : <p>{online ? '当前电脑暂未返回额度信息。' : '电脑离线，连接后可读取额度。'}</p>}
      <button type="button" disabled={!online || loading} onClick={() => refresh.current()}>{loading ? '读取中…' : '刷新额度'}</button>
    </section>}
  </div>;
}
