import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Analysis } from './analysis.tsx';
import { ArtifactPreview, artifactUrl, IndependentPreview } from './artifacts.tsx';
import { Chat } from './chat.tsx';
import { Generation, JobList, useJobs } from './jobs.tsx';
import { LibraryPicker, useLibrary } from './library.tsx';
import { SourceUpload, useSources } from './sources.tsx';
import './styles.css';

type ServiceState =
  | { status: 'checking' | 'offline' }
  | { status: 'online'; modelConfigured: boolean };

const serviceLabels = {
  checking: '正在检查服务',
  online: '服务已连接',
  offline: '服务连接失败',
};

function ServiceStatus() {
  const [service, setService] = useState<ServiceState>({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);

    async function checkService() {
      try {
        const response = await fetch('/api/health', { signal, cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Health check failed');
        }
        const health = await response.json();
        if (health?.status !== 'ok' || typeof health.modelConfigured !== 'boolean') {
          throw new Error('Invalid health response');
        }
        if (!controller.signal.aborted) {
          setService({ status: 'online', modelConfigured: health.modelConfigured });
        }
      } catch {
        if (!controller.signal.aborted) {
          setService({ status: 'offline' });
        }
      }
    }

    void checkService();
    return () => controller.abort();
  }, [attempt]);

  function retry() {
    if (service.status !== 'offline') {
      return;
    }
    setService({ status: 'checking' });
    setAttempt((previous) => previous + 1);
  }

  const retrying = service.status === 'checking' && attempt > 0;

  return (
    <div className="service">
      <div className="service-status" role="status">
        <span className={`status-dot ${service.status}`} aria-hidden="true" />
        <span>{serviceLabels[service.status]}</span>
        {service.status === 'online' && (
          <span className="model-status">{service.modelConfigured ? '模型已配置' : '模型未配置'}</span>
        )}
      </div>
      {(service.status === 'offline' || retrying) && (
        <button aria-disabled={retrying} onClick={retry}>重新连接</button>
      )}
    </div>
  );
}

function Workbench() {
  const [chatDraft, setChatDraft] = useState('');
  const jobs = useJobs();
  const [previewId, setPreviewId] = useState<string>();
  const preview = jobs.items.find(({ id }) => id === previewId);
  const sources = useSources();
  const library = useLibrary(sources.entries.map(({ source }) => source.id + source.status).join(','));
  const selected = { sourceIds: sources.selectedIds, libraryIds: library.selectedIds,
    version: JSON.stringify([sources.selectedIds, library.chosen.filter(({ id }) => library.selectedIds.includes(id))
      .map(({ id, documentCount }) => [id, documentCount])]) };
  return (
    <>
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>写作助手</h1>
        </div>
        <ServiceStatus />
      </header>

      <main className="workbench">
        <aside className="panel" aria-labelledby="sources-title">
          <h2 id="sources-title">写作来源</h2>
          <div className="panel-section first-section">
            <h3>写作素材</h3>
            <label className="section-control inline"><input type="checkbox" checked={library.includeInLibrary}
              onChange={(event) => library.setIncludeInLibrary(event.currentTarget.checked)} />纳入知识库</label>
            <SourceUpload workspace={sources} includeInLibrary={library.includeInLibrary} />
          </div>
          <div className="panel-section">
            <h3>引用知识库</h3>
            <LibraryPicker library={library} />
          </div>
        </aside>

        <section className="panel writing-panel" aria-labelledby="writing-title">
          <h2 id="writing-title">分析与对话</h2>
          <p className="panel-note">已选 {sources.selectedIds.length + library.selectedIds.length} 个来源</p>
          <Analysis selected={selected} onSave={async (summaryId) => { await jobs.submit({ summaryId }); }} />
          <Chat selected={selected} draft={chatDraft} setDraft={setChatDraft} />
        </section>

        <aside className="panel" aria-labelledby="results-title">
          <h2 id="results-title">生成结果</h2>
          {preview && <ArtifactPreview key={preview.id} job={preview} close={() => setPreviewId(undefined)} />}
          <div hidden={Boolean(preview)}>
            <div className="panel-section first-section"><Generation selected={selected} chatDraft={chatDraft} submit={jobs.submit} /></div>
            <div className="panel-section">
              <h3>生成记录</h3>
              <JobList jobs={jobs} renderActions={(job) => job.artifactId && <>
                <button onClick={() => setPreviewId(job.id)}>预览</button>
                <a href={artifactUrl(job.artifactId, 'download')} download>下载 HTML</a>
              </>} />
            </div>
          </div>
        </aside>
      </main>
    </>
  );
}

const artifact = new URLSearchParams(window.location.search).get('artifact');
createRoot(document.getElementById('root')!).render(artifact !== null ? <IndependentPreview id={artifact} /> : <Workbench />);
