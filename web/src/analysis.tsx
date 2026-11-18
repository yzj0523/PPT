import { useEffect, useState } from 'react';
import { errorMessage, post } from './api.ts';
import type { Citation, Selection } from './api.ts';

export type Summary = { id: string; content: string; keyPoints: string[]; citations: Citation[]; version: string;
  partial: boolean; createdAt: string };

export function Citations({ items }: { items: Citation[] }) {
  if (!items.length) return null;
  return <ul className="citations" aria-label="引用来源">{items.map((item) => <li key={item.id}>
    {item.library && item.library + ' · '}{item.name}{item.format === 'pdf' ? ' · 第 ' + item.number + ' 页' : ' · 第 ' + item.number + ' 段'}
  </li>)}</ul>;
}

export function Analysis({ selected, onSave }: { selected: Selection; onSave?: (id: string) => Promise<void> }) {
  const [summary, setSummary] = useState<Summary>();
  const [request, setRequest] = useState({ count: 0, requirements: '' });
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<{ version: string; pending?: boolean; error?: string }>();
  const [saveStatus, setSaveStatus] = useState<{ id: string; pending?: boolean; error?: string; saved?: boolean }>();
  const sourceIds = selected.sourceIds.join(',');
  const libraryIds = selected.libraryIds.join(',');
  const { version } = selected;

  useEffect(() => {
    if (!sourceIds && !libraryIds) { setSummary(undefined); setState(undefined); return; }
    const controller = new AbortController();
    setState({ version, pending: true });
    const timer = setTimeout(() => {
      void post<Summary>('/api/analysis', { sourceIds: sourceIds ? sourceIds.split(',') : [],
        libraryIds: libraryIds ? libraryIds.split(',') : [], version, requirements: request.requirements }, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted && result.version === version) {
            setSummary(result);
            setState({ version });
          }
        }).catch((error) => {
          if (!controller.signal.aborted) setState({ version, error: errorMessage(error) });
        });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [sourceIds, libraryIds, version, request]);

  const current = summary?.version === version ? summary : undefined;
  const status = state?.version === version ? state : undefined;
  if (!sourceIds && !libraryIds) return null;

  async function save(id: string) {
    setSaveStatus({ id, pending: true });
    try { await onSave?.(id); setSaveStatus({ id, saved: true }); }
    catch (error) { setSaveStatus({ id, error: errorMessage(error) }); }
  }

  return <section className="work-section analysis-card" aria-label="文档分析">
    <h3>文档分析</h3>
    <form className="row-actions" onSubmit={(event) => {
      event.preventDefault();
      setRequest({ count: request.count + 1, requirements: draft.trim() });
    }}>
      <label className="field grow">摘要要求<input value={draft} maxLength={4000} onChange={(event) => setDraft(event.currentTarget.value)} /></label>
      <button type="submit" className="aligned">重新分析</button>
    </form>
    {status?.pending && <p role="status" className="muted">正在分析所选来源…</p>}
    {status?.error && <p role="alert" className="error">{status.error}</p>}
    {current && <div className="answer">
      <p>{current.content}</p>
      <ul>{current.keyPoints.map((point, index) => <li key={index}>{point}</li>)}</ul>
      <Citations items={current.citations} />
      {current.partial && <p className="muted">本次分析使用了部分材料。</p>}
      <time className="muted" dateTime={current.createdAt}>{new Date(current.createdAt).toLocaleString('zh-CN')}</time>
      {onSave && <div className="row-actions"><button disabled={saveStatus?.id === current.id && saveStatus.pending}
        onClick={() => void save(current.id)}>保存为记录</button>
        {saveStatus?.id === current.id && saveStatus.saved && <span role="status">已保存</span>}
        {saveStatus?.id === current.id && saveStatus.error && <span role="alert" className="error">{saveStatus.error}</span>}
      </div>}
    </div>}
  </section>;
}
