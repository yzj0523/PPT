import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, post } from './api.ts';
import type { Selection } from './api.ts';

export type Job = { id: string; skill: string; title: string; status: 'queued' | 'generating' | 'completed' | 'failed';
  phase: string; error: string | null; artifactId: string | null; createdAt: string; updatedAt: string; sequence: number; partial: boolean };

export function useJobs() {
  const [items, setItems] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const deleted = useRef(new Set<string>());
  const merge = useCallback((updates: Job[]) => {
    setItems((previous) => {
      const jobs = new Map(previous.map((job) => [job.id, job]));
      for (const job of updates) {
        if (!deleted.current.has(job.id) && (jobs.get(job.id)?.sequence ?? 0) < job.sequence) jobs.set(job.id, job);
      }
      return [...jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: Job[] }>('/api/jobs', { signal: controller.signal }).then((result) => merge(result.items)).catch((error) => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    });
    return () => controller.abort();
  }, [merge]);

  const active = items.filter((job) => job.status === 'queued' || job.status === 'generating');
  const streamId = active[0]?.id;
  const hasOverflow = active.length > 1;

  useEffect(() => {
    if (!streamId) return;
    const controller = new AbortController();
    const path = '/api/jobs/' + streamId;
    let stream: EventSource;
    let retry: ReturnType<typeof setTimeout>;

    function connect() {
      if (controller.signal.aborted) return;
      stream = new EventSource(path + '/events');
      stream.onmessage = (event) => {
        if (controller.signal.aborted) return;
        const job = JSON.parse(event.data) as Job;
        if (job.id !== streamId) return;
        if (job.status === 'completed' || job.status === 'failed') stream.close();
        merge([job]);
      };
      stream.onerror = () => {
        stream.close();
        if (!controller.signal.aborted) retry = setTimeout(recover, 400);
      };
    }

    async function recover() {
      try {
        const job = await api<Job>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        merge([job]);
        if (job.status === 'queued' || job.status === 'generating') connect();
      } catch {
        if (!controller.signal.aborted) retry = setTimeout(recover, 1000);
      }
    }

    connect();
    return () => { controller.abort(); stream?.close(); clearTimeout(retry); };
  }, [streamId, merge]);

  useEffect(() => {
    if (!hasOverflow) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const { items } = await api<{ items: Job[] }>('/api/jobs', { signal: controller.signal });
        if (!controller.signal.aborted) merge(items);
      } catch {
        // Try the next snapshot after a temporary connection failure.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 500);
      }
    }

    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [hasOverflow, merge]);

  async function submit(body: object) {
    const job = await post<Job>('/api/jobs', body);
    merge([job]);
    return job;
  }

  async function retry(id: string, key: string) {
    const job = await post<Job>('/api/jobs/' + id + '/retry', { idempotencyKey: key });
    merge([job]);
  }

  async function rename(id: string, title: string) {
    const result = await api<Job>('/api/artifacts/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }) });
    merge([result]);
  }

  async function remove(id: string) {
    await api('/api/jobs/' + id, { method: 'DELETE' });
    deleted.current.add(id);
    setItems((previous) => previous.filter((job) => job.id !== id));
  }

  return { items, error, submit, retry, rename, remove };
}

export function Generation({ selected, chatDraft, submit }: { selected: Selection; chatDraft: string;
  submit: (body: object) => Promise<Job> }) {
  const [skill, setSkill] = useState<'ppt' | 'writing' | 'mindmap'>('ppt');
  const [length, setLength] = useState('medium');
  const [descriptions, setDescriptions] = useState({ ppt: '', writing: '', mindmap: '' });
  const [mode, setMode] = useState('general');
  const [issuer, setIssuer] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submission = useRef<{ payload: string; key: string } | undefined>(undefined);

  async function generate() {
    const requirement = descriptions[skill].trim() || (skill === 'ppt' ? chatDraft.trim() : '');
    if (!requirement && !selected.sourceIds.length && !selected.libraryIds.length) {
      setError('请选择可用来源或填写生成要求。');
      return;
    }
    const options = skill === 'ppt' ? { length } : skill === 'writing' ? { mode, issuer, date } : {};
    const body = { ...selected, skill, description: requirement, ...options };
    const payload = JSON.stringify(body);
    if (submission.current?.payload !== payload) submission.current = { payload, key: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      await submit({ ...body, idempotencyKey: submission.current.key });
      submission.current = undefined;
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  return <form className="generation-form" onSubmit={(event) => { event.preventDefault(); if (!busy) void generate(); }}>
    <div className="row-actions" aria-label="生成类型">
      <button type="button" aria-pressed={skill === 'ppt'} onClick={() => { setError(''); setSkill('ppt'); }}>演讲文稿</button>
      <button type="button" aria-pressed={skill === 'writing'} onClick={() => { setError(''); setSkill('writing'); }}>通用写作</button>
      <button type="button" aria-pressed={skill === 'mindmap'} onClick={() => { setError(''); setSkill('mindmap'); }}>思维导图</button>
    </div>
    {skill === 'ppt' ? <label className="field">篇幅<select value={length} onChange={(event) => setLength(event.currentTarget.value)}>
      <option value="short">短（4–6 页）</option><option value="medium">中（7–10 页）</option><option value="long">长（11–15 页）</option>
    </select></label> : skill === 'writing' ? <>
      <label className="field">文稿类型<select value={mode} onChange={(event) => setMode(event.currentTarget.value)}>
        <option value="general">通用文稿</option><option value="notice">通知</option>
      </select></label>
      {mode === 'notice' && <>
        <label className="field">发文单位（选填）<input value={issuer} maxLength={150} onChange={(event) => setIssuer(event.currentTarget.value)} /></label>
        <label className="field">日期（选填）<input value={date} maxLength={60} onChange={(event) => setDate(event.currentTarget.value)} /></label>
      </>}
    </> : null}
    <label className="field">{{ ppt: 'Slide 描述', writing: '写作要求', mindmap: '导图主题' }[skill]}<textarea value={descriptions[skill]} rows={3} maxLength={4000}
      onChange={(event) => setDescriptions({ ...descriptions, [skill]: event.currentTarget.value })} /></label>
    <button type="submit" className="primary" disabled={busy}>{{ ppt: '生成演讲文稿', writing: '生成文稿', mindmap: '生成导图' }[skill]}</button>
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}

export function JobList({ jobs, renderActions }: { jobs: ReturnType<typeof useJobs>; renderActions?: (job: Job) => React.ReactNode }) {
  const [activeId, setActiveId] = useState<string>();
  const [retrying, setRetrying] = useState<string>();
  const [retryError, setRetryError] = useState('');
  const retryKeys = useRef(new Map<string, string>());
  const [management, setManagement] = useState<{ id: string; type: 'rename' | 'delete' }>();
  const [name, setName] = useState('');
  const [managementError, setManagementError] = useState('');
  const [saving, setSaving] = useState(false);
  const active = jobs.items.find((job) => job.id === activeId);
  const target = jobs.items.find((job) => job.id === management?.id);

  async function retry(id: string) {
    const key = retryKeys.current.get(id) ?? crypto.randomUUID();
    retryKeys.current.set(id, key);
    setRetrying(id);
    setRetryError('');
    try { await jobs.retry(id, key); retryKeys.current.delete(id); }
    catch (error) { setRetryError(errorMessage(error)); }
    finally { setRetrying(undefined); }
  }

  async function manage() {
    if (!management || !target || saving) return;
    setManagementError('');
    setSaving(true);
    try {
      if (management.type === 'rename') {
        if (!target.artifactId) throw new Error('找不到可用的生成产物。');
        await jobs.rename(target.artifactId, name.trim());
      } else await jobs.remove(target.id);
      setManagement(undefined);
    } catch (error) { setManagementError(errorMessage(error)); }
    finally { setSaving(false); }
  }
  return <>
    {jobs.error && <p role="alert" className="error">{jobs.error}</p>}
    {retryError && <p role="alert" className="error">{retryError}</p>}
    {!jobs.items.length && <p className="side-empty">暂无生成记录</p>}
    <ul className="source-list" aria-label="生成记录">
      {jobs.items.map((job) => <li key={job.id}>
        <strong>{job.title}</strong>
        <p className="muted">{job.phase}</p>
        {job.error && <p className="error">{job.error}</p>}
        {job.partial && <p className="muted">本次使用了部分材料。</p>}
        <div className="row-actions"><button onClick={() => setActiveId(job.id)}>进度</button>
          {job.status === 'failed' && <button disabled={Boolean(retrying)} onClick={() => void retry(job.id)}>重试生成</button>}
          {renderActions?.(job)}
          {job.artifactId && <button onClick={() => { setName(job.title); setManagementError(''); setManagement({ id: job.id, type: 'rename' }); }}>重命名</button>}
          {(job.status === 'completed' || job.status === 'failed') && <button onClick={() => {
            setManagementError(''); setManagement({ id: job.id, type: 'delete' });
          }}>删除</button>}
        </div>
      </li>)}
    </ul>
    {active && <dialog open className="picker" aria-label="任务进度" onKeyDown={(event) => {
      if (event.key === 'Escape') setActiveId(undefined);
    }}><h2>{active.title}</h2><p role="status">{active.phase}</p>{active.error && <p className="error">{active.error}</p>}
      <button className="section-control" onClick={() => setActiveId(undefined)}>关闭</button>
    </dialog>}
    {management && target && <dialog open className="picker" aria-label={management.type === 'rename' ? '重命名记录' : '删除记录'}
      onKeyDown={(event) => { if (event.key === 'Escape' && !saving) setManagement(undefined); }}>
      <h2>{management.type === 'rename' ? '重命名记录' : '删除记录'}</h2>
      <form onSubmit={(event) => { event.preventDefault(); void manage(); }}>
        {management.type === 'rename' ? <label className="field">新标题<input maxLength={150} autoFocus value={name}
          onChange={(event) => setName(event.currentTarget.value)} /></label> : <p>删除「{target.title}」及其产物？</p>}
        {managementError && <p role="alert" className="error">{managementError}</p>}
        <div className="row-actions"><button type="button" disabled={saving} onClick={() => setManagement(undefined)}>取消</button>
          <button type="submit" className="primary" disabled={saving || management.type === 'rename' && !name.trim()}>
            {management.type === 'rename' ? '保存名称' : '确认删除'}</button></div>
      </form>
    </dialog>}
  </>;
}
