import { useEffect, useState } from 'react';
import type { Job } from './jobs.tsx';

export function artifactUrl(id: string, action: 'preview' | 'download') {
  return '/api/artifacts/' + encodeURIComponent(id) + '/' + action;
}

function previewLink(id: string) {
  return '/?artifact=' + encodeURIComponent(id);
}

function ArtifactFrame({ id }: { id: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const url = artifactUrl(id, 'preview');
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { method: 'HEAD', signal: controller.signal, cache: 'no-store' })
      .then((response) => { if (!controller.signal.aborted) setState(response.ok ? 'ready' : 'error'); })
      .catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [url]);

  if (state === 'error') return <p className="error" role="alert">找不到可用的生成产物。</p>;
  if (state === 'loading') return <p role="status" className="muted">正在加载预览…</p>;
  return <iframe title="产物预览" sandbox="" src={url} />;
}

export function IndependentPreview({ id }: { id: string }) {
  return <main className="preview-section independent-preview">
    <div className="preview-header"><h1>产物预览</h1><div className="row-actions">
      <a href="/">返回工作台</a><a href={artifactUrl(id, 'download')} download>下载 HTML</a>
    </div></div>
    <ArtifactFrame id={id} />
  </main>;
}

export function ArtifactPreview({ job, close }: { job: Job; close: () => void }) {
  const [copy, setCopy] = useState<'copied' | 'manual'>();
  const id = job.artifactId!;
  const link = previewLink(id);
  const localUrl = new URL(link, window.location.origin).href;
  async function copyLink() {
    try { await navigator.clipboard.writeText(localUrl); setCopy('copied'); }
    catch { setCopy('manual'); }
  }

  return <section className="panel-section preview-section" aria-label="产物预览">
    <h3>{job.title}</h3>
    <div className="row-actions"><button onClick={close}>返回记录</button>
      <a href={artifactUrl(id, 'download')} download>下载 HTML</a>
      <a href={link} target="_blank" rel="noopener noreferrer">在新窗口预览</a>
      <button onClick={() => void copyLink()}>复制本地链接</button>
    </div>
    {copy === 'copied' && <p role="status">已复制链接</p>}
    {copy === 'manual' && <label className="field section-control">手动复制链接<input readOnly value={localUrl}
      onFocus={(event) => event.currentTarget.select()} /></label>}
    <ArtifactFrame id={id} />
  </section>;
}
