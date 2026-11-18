import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type Library = { id: string; name: string; description: string; documentCount: number };

export function useLibrary(refreshKey: string) {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [includeInLibrary, setIncludeInLibrary] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/knowledge-bases', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const body = await response.json() as { items: Library[] };
      if (!controller.signal.aborted) {
        setLibraries(body.items);
        setError('');
      }
    }).catch(() => {
      if (!controller.signal.aborted) setError('读取知识库失败。');
    });
    return () => controller.abort();
  }, [refreshKey]);

  const chosen = libraries.filter(({ id }) => Object.hasOwn(selection, id));
  return {
    libraries, chosen, selection, setSelection, error, includeInLibrary, setIncludeInLibrary,
    selectedIds: chosen.filter(({ id, documentCount }) => selection[id] && documentCount > 0).map(({ id }) => id),
  };
}

export function LibraryPicker({ library }: { library: ReturnType<typeof useLibrary> }) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [search, setSearch] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const isOpen = draft !== null;
  const { libraries, chosen, selection, setSelection, error } = library;
  const visible = libraries.filter(({ name }) => name.toLowerCase().includes(search.trim().toLowerCase()));
  const allVisible = visible.length > 0 && visible.every(({ id }) => draft?.includes(id));

  useLayoutEffect(() => {
    const panel = dialog.current;
    const button = opener.current;
    if (!isOpen || !panel) return;
    panel.showModal();
    searchField.current?.focus();
    return () => { panel.close(); button?.focus(); };
  }, [isOpen]);

  return (
    <>
      <button ref={opener} className="section-control" onClick={() => { setSearch(''); setDraft(Object.keys(selection)); }}>选择知识库</button>
      {error && <p role="alert" className="error">{error}</p>}
      {!chosen.length && <p className="side-empty">暂无已选知识库</p>}
      {!!chosen.length && <label className="section-control inline"><input type="checkbox" checked={chosen.every(({ id }) => selection[id])}
        onChange={(event) => setSelection(Object.fromEntries(chosen.map(({ id }) => [id, event.currentTarget.checked])))} />启用全部已选库</label>}
      <ul className="source-list" aria-label="已选知识库">
        {chosen.map(({ id, name, documentCount }) => <li key={id}>
          <label className="source-name"><input type="checkbox" checked={selection[id]}
            onChange={(event) => setSelection({ ...selection, [id]: event.currentTarget.checked })} />{name}</label>
          <p className="muted">{documentCount ? documentCount + ' 份文档' : '没有可引用内容'}</p>
          <button className="section-control" aria-label={'移除 ' + name}
            onClick={() => setSelection(Object.fromEntries(Object.entries(selection).filter(([key]) => key !== id)))}>移除</button>
        </li>)}
      </ul>
      {draft && <dialog ref={dialog} className="picker" aria-labelledby="library-dialog-title"
        onCancel={(event) => { event.preventDefault(); setDraft(null); }}>
        <h2 id="library-dialog-title">选择知识库</h2>
        <label className="field">搜索知识库<input ref={searchField} value={search} onChange={(event) => setSearch(event.currentTarget.value)} /></label>
        <label className="section-control inline"><input type="checkbox" checked={allVisible} disabled={!visible.length}
          onChange={(event) => {
            const ids = visible.map(({ id }) => id);
            setDraft(event.currentTarget.checked ? Array.from(new Set([...draft, ...ids])) : draft.filter((id) => !ids.includes(id)));
          }} />全选搜索结果</label>
        {!visible.length && <p className="side-empty">没有匹配的知识库</p>}
        <ul className="source-list">
          {visible.map(({ id, name, documentCount }) => <li key={id}>
            <label className="source-name"><input type="checkbox" checked={draft.includes(id)}
              onChange={(event) => setDraft(event.currentTarget.checked ? [...draft, id] : draft.filter((key) => key !== id))} />{name}</label>
            <p className="muted">{documentCount ? documentCount + ' 份文档' : '没有可引用内容'}</p>
          </li>)}
        </ul>
        <div className="row-actions">
          <button onClick={() => setDraft(null)}>取消</button>
          <button className="primary" onClick={() => {
            setSelection(Object.fromEntries(draft.map((id) => [id, selection[id] ?? true])));
            setDraft(null);
          }}>确定</button>
        </div>
      </dialog>}
    </>
  );
}
