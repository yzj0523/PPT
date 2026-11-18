import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createModelProvider } from '../server/ai.ts';
import { createWorkbenchServer, loopbackHost } from '../server/app.ts';
import type { Summary } from '../server/analysis.ts';
import type { Job } from '../server/jobs.ts';
import { makeDocx, makePdf } from './documents.ts';

async function verifyLiveModel() {
  const model = createModelProvider();
  if (!model.configured) {
    console.error('真实模型验收阻塞。请在 .env.local 或当前终端设置 AI_BASE_URL、AI_MODEL 和 AI_API_KEY。');
    process.exitCode = 1;
    return;
  }
  const app = createWorkbenchServer({ databasePath: ':memory:', model });
  try {
    const base = await app.listen({ host: loopbackHost, port: 0 });
    async function json<T>(path: string, input?: unknown): Promise<T> {
      const options = input === undefined ? {} : input instanceof FormData ? { method: 'POST', body: input } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      };
      const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(120000) });
      const data = await response.json();
      assert.ok(response.ok, path + ' returned ' + response.status + ' ' + (data.error?.message ?? ''));
      return data as T;
    }
    async function wait<T>(path: string, ready: (row: T) => boolean) {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const row = await json<T>(path);
        if (ready(row)) return row;
        await setTimeout(300);
      }
      throw new Error('等待超时 ' + path);
    }
    async function download(id: string | null) {
      assert.ok(id);
      const response = await fetch(base + '/api/artifacts/' + id + '/download');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      return await response.text();
    }

    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(makePdf(['Project Cedar meets in Room 208.']))]), 'Project Cedar.pdf');
    form.append('files', new Blob([new Uint8Array(await makeDocx([['The Project Cedar workshop capacity is 36 people.']]))]), 'Capacity.docx');
    const { items } = await json<{ items: Array<{ id: string }> }>('/api/sources', form);
    for (const { id } of items) {
      const item = await wait<{ status: string }>('/api/sources/' + id, ({ status }) => status !== 'parsing');
      assert.equal(item.status, 'ready');
    }
    const selected = { sourceIds: items.map(({ id }) => id), libraryIds: ['sample-writing'], version: 'live-check' };
    const summary = await json<Summary>('/api/analysis', { ...selected, requirements: '请写明项目房间编号 208 和容量 36，保留数字。' });
    assert.match(summary.content, /208/);
    assert.match(summary.content, /36/);
    assert.ok(summary.citations.length);

    const question = 'Project Cedar 在哪间房？请用阿拉伯数字回答。';
    const first = await json<{ content: string; citations: unknown[] }>('/api/chat', { ...selected, question });
    assert.match(first.content, /208/);
    assert.ok(first.citations.length);
    const second = await json<{ content: string; citations: unknown[] }>('/api/chat', {
      ...selected, question: '那么，刚才这个项目的工作坊可以容纳多少人？请用阿拉伯数字回答。',
      history: [{ role: 'user', content: question, version: selected.version },
        { role: 'assistant', content: first.content, version: selected.version }],
    });
    assert.match(second.content, /36/);
    assert.ok(second.citations.length);

    for (const skill of ['ppt', 'writing', 'mindmap']) {
      const created = await json<Job>('/api/jobs', { ...selected, skill, length: 'short',
        description: '介绍工作坊。请在产物中原样保留英文项目名称 Project Cedar。' });
      const job = await wait<Job>('/api/jobs/' + created.id, ({ status }) => status === 'completed' || status === 'failed');
      assert.equal(job.status, 'completed', job.error ?? '');
      const html = await download(job.artifactId);
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /Project Cedar/i);
      if (skill === 'ppt') {
        const count = html.match(/id="slide-/g)?.length ?? 0;
        assert.ok(count >= 4 && count <= 6);
      }
    }
    const notice = await json<Job>('/api/jobs', { ...selected, libraryIds: [], skill: 'writing', mode: 'notice',
      description: '为 Project Cedar 起草工作坊通知。材料仅提供地点和容量，发布单位和发布日期待补。' });
    const noticeJob = await wait<Job>('/api/jobs/' + notice.id, ({ status }) => status === 'completed' || status === 'failed');
    assert.equal(noticeJob.status, 'completed', noticeJob.error ?? '');
    const noticeHtml = await download(noticeJob.artifactId);
    assert.match(noticeHtml, /<footer><p>【待填写发文单位】<\/p><p>【待填写日期】<\/p>/);
    const saved = await json<Job>('/api/jobs', { summaryId: summary.id });
    assert.match(await download(saved.artifactId), /引用来源/);
    console.log('真实模型验收通过。已验证 PDF、DOCX、摘要、两轮问答、三种产物和摘要导出。');
  } finally { await app.close(); }
}

await verifyLiveModel();
