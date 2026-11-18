import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';

export type Source = {
  id: string;
  name: string;
  status: 'parsing' | 'ready' | 'failed';
  error: { message: string } | null;
};

type SourceEntry = { source: Source; file: File; selected: boolean };

export function useSources() {
  const [entries, setEntries] = useState<SourceEntry[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState('');
  const pendingIds = entries.filter(({ source }) => source.status === 'parsing').map(({ source }) => source.id).join(',');

  useEffect(() => {
    if (!pendingIds) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const results = await Promise.allSettled(pendingIds.split(',').map(async (id) => {
          const response = await fetch('/api/sources/' + id, { signal: controller.signal, cache: 'no-store' });
          if (response.status === 404) return { id, missing: true } as const;
          if (!response.ok) throw new Error('读取来源状态失败。');
          return await response.json() as Source;
        }));
        if (!controller.signal.aborted) {
          const sources = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
          setEntries((previous) => previous.map((entry) => {
            const result = sources.find(({ id }) => id === entry.source.id);
            if (!result) return entry;
            if ('missing' in result) return { ...entry, source: { ...entry.source, status: 'failed', error: { message: '来源已失效，请重新上传。' } } };
            return { ...entry, source: result };
          }));
          if (results.some((result) => result.status === 'rejected')) setError('读取来源状态失败，正在重试。');
          else setError((previous) => previous === '读取来源状态失败，正在重试。' ? '' : previous);
        }
      } catch {
        if (!controller.signal.aborted) setError('读取来源状态失败，正在重试。');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 400);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pendingIds]);

  async function upload(files: File[], includeInLibrary = false, replacing?: string) {
    if (!files.length) return;
    const form = new FormData();
    form.append('includeInLibrary', String(includeInLibrary));
    for (const file of files) form.append('files', file);
    setError('');
    setUploading((count) => count + 1);
    try {
      const response = await fetch('/api/sources', { method: 'POST', body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? '上传失败。');
      const sources = body.items as Source[];
      if (replacing) await remove(replacing);
      setEntries((previous) => [...previous, ...sources.map((source, index) => ({ source, file: files[index], selected: true }))]);
    } catch (error) {
      setError(error instanceof Error ? error.message : '上传失败。');
    } finally {
      setUploading((count) => count - 1);
    }
  }

  async function remove(id: string) {
    try {
      const response = await fetch('/api/sources/' + id, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new Error();
      setEntries((previous) => previous.filter(({ source }) => source.id !== id));
    } catch {
      setError('移除来源失败。');
    }
  }

  return {
    entries, uploading: uploading > 0, error, upload, remove,
    select(id: string, selected: boolean) {
      setEntries((previous) => previous.map((entry) => entry.source.id === id ? { ...entry, selected } : entry));
    },
    selectedIds: entries.filter(({ source, selected }) => selected && source.status === 'ready').map(({ source }) => source.id),
  };
}

export function SourceUpload({ workspace, includeInLibrary = false }: {
  workspace: ReturnType<typeof useSources>;
  includeInLibrary?: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const { entries, uploading, error, upload, remove, select } = workspace;

  function paste(event: ClipboardEvent) {
    if (!event.clipboardData?.files.length) return;
    event.preventDefault();
    void upload(Array.from(event.clipboardData.files), includeInLibrary);
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    void upload(Array.from(event.dataTransfer.files), includeInLibrary);
  }

  return (
    <>
      <button className="upload-zone" onClick={() => picker.current?.click()} onPaste={paste}
        onDragOver={(event) => event.preventDefault()} onDrop={drop}>
        <strong>导入 PDF 或 DOCX</strong>
        <span>点击选择，或拖放、粘贴文件</span>
      </button>
      <input ref={picker} hidden aria-label="选择文件" type="file" multiple accept=".pdf,.docx"
        onChange={(event) => {
          void upload(Array.from(event.currentTarget.files ?? []), includeInLibrary);
          event.currentTarget.value = '';
        }} />
      {uploading && <p role="status">正在上传文件…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {entries.length === 0 && <p className="side-empty">暂无写作素材</p>}
      <ul className="source-list" aria-label="写作素材">
        {entries.map(({ source, file, selected }) => (
          <li key={source.id}>
            <label className="source-name">
              <input type="checkbox" checked={selected} disabled={source.status !== 'ready'}
                onChange={(event) => select(source.id, event.currentTarget.checked)} />
              <span>{source.name}</span>
            </label>
            <p className={source.status === 'failed' ? 'error' : 'muted'}>
              {source.status === 'ready' ? '可用' : source.status === 'parsing' ? '解析中' : source.error?.message ?? '解析失败'}
            </p>
            <div className="row-actions">
              {source.status === 'failed' && <button onClick={() => void upload([file], includeInLibrary, source.id)}>重试</button>}
              <button onClick={() => void remove(source.id)} aria-label={'移除 ' + source.name}>移除</button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
