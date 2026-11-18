import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createWorkbenchServer, loopbackHost } from '../server/app.ts';
import type { Job } from '../server/jobs.ts';

async function listen(t: TestContext, options: Parameters<typeof createWorkbenchServer>[0] = {}) {
  const app = createWorkbenchServer({ databasePath: ':memory:', ...options });
  t.after(() => app.close());
  return app.listen({ host: loopbackHost, port: 0 });
}

function submit(base: string, body: unknown) {
  return fetch(base + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function getJob(base: string, id: string, condition: (job: Job) => boolean = (job) => ['completed', 'failed'].includes(job.status)) {
  for (let count = 0; count < 200; count += 1) {
    const response = await fetch(base + '/api/jobs/' + id);
    assert.equal(response.status, 200);
    const job = await response.json() as Job;
    if (condition(job)) return job;
    await setTimeout(15);
  }
  assert.fail('Timed out waiting for a job');
}

test('jobs retain independent snapshots, idempotency and atomic terminal state', async (t) => {
  let unblock = () => {};
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  t.after(unblock);
  const base = await listen(t, { artifactSkills: { test: { async generate({ description, fragments }) {
    await blocked;
    if (description === 'empty') return { title: 'Empty', content: {}, html: '' };
    const content = { fragments: fragments.map(({ text }) => text) };
    return { title: 'Shared title', content, html: '<p>' + description + '</p>' };
  } } } });
  const first = await (await submit(base, { skill: 'test', description: 'One', idempotencyKey: 'repeat', libraryIds: ['sample-writing'] })).json() as Job;
  const repeated = await (await submit(base, { skill: 'test', description: 'Two', idempotencyKey: 'repeat' })).json() as Job;
  const second = await (await submit(base, { skill: 'test', description: 'Two', idempotencyKey: 'new' })).json() as Job;
  const empty = await (await submit(base, { skill: 'test', description: 'empty' })).json() as Job;
  assert.equal(first.status, 'queued');
  assert.equal(first.id, repeated.id);
  assert.notEqual(first.id, second.id);
  await getJob(base, first.id, (job) => job.status === 'generating');
  unblock();
  const [one, two, failed] = await Promise.all([first, second, empty].map(({ id }) => getJob(base, id)));
  assert.equal(one.status, 'completed');
  assert.equal(two.status, 'completed');
  assert.equal(one.title, two.title);
  assert.ok(one.artifactId && two.artifactId && one.artifactId !== two.artifactId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.artifactId, null);
  const { items } = await (await fetch(base + '/api/jobs')).json() as { items: Job[] };
  assert.equal(items.length, 3);
  assert.deepEqual(items.find(({ id }) => id === one.id), one);
});

test('PPT accepts the three input combinations and rejects missing or malformed slides', async (t) => {
  let malformed = false;
  const base = await listen(t, { model: { configured: true, async complete(_prompt, input) {
    const { description, fragments, minSlides } = input as { description: string; fragments: unknown[]; minSlides: number };
    return { title: description || 'From ' + fragments.length + ' sources',
      slides: Array.from({ length: minSlides }, () => ({ title: 'Slide title', points: malformed ? [] : ['Slide text'] })) };
  } } });
  for (const options of [{ description: 'Short', length: 'short' }, { libraryIds: ['sample-writing'] },
    { description: 'Long', libraryIds: ['sample-writing'], length: 'long' }]) {
    const submitted = await submit(base, { skill: 'ppt', ...options });
    assert.equal(submitted.status, 202);
    assert.equal((await getJob(base, (await submitted.json()).id)).status, 'completed');
  }
  assert.equal((await submit(base, { skill: 'ppt' })).status, 400);
  assert.equal((await submit(base, { skill: 'ppt', description: 'Bad length', length: 'other' })).status, 400);
  malformed = true;
  const broken = await (await submit(base, { skill: 'ppt', description: 'Missing points' })).json();
  assert.equal((await getJob(base, broken.id)).status, 'failed');
});

test('SSE delivers job-scoped progress with monotonic sequence and a terminal artifact ID', async (t) => {
  const base = await listen(t, { artifactSkills: { test: { async generate({ description }) {
    await setTimeout(50);
    return { title: description, content: {}, html: '<p>Content</p>' };
  } } } });
  const created = await (await submit(base, { skill: 'test', description: 'Streamed' })).json() as Job;
  const response = await fetch(base + '/api/jobs/' + created.id + '/events');
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const updates = (await response.text()).split('\n').filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Job);
  assert.ok(updates.every(({ id }) => id === created.id));
  assert.ok(updates.every(({ sequence }, index) => !index || sequence > updates[index - 1].sequence));
  assert.ok(updates.some(({ status }) => status === 'generating'));
  assert.equal(updates.at(-1)?.status, 'completed');
  assert.ok(updates.at(-1)?.artifactId);
});

test('same-title PPT artifacts preserve independent HTML and safe download filenames', async (t) => {
  const base = await listen(t, { model: { configured: true, async complete(_prompt, value) {
    const { description, minSlides } = value as { description: string; minSlides: number };
    return { title: '相同标题', slides: Array.from({ length: minSlides }, () => ({ title: '页标题', body: description })) };
  } } });
  for (const description of ['独立正文一 <示例>', '独立正文二 & 样例']) {
    const { id } = await (await submit(base, { skill: 'ppt', description, length: 'short' })).json();
    const job = await getJob(base, id);
    assert.equal(job.status, 'completed');
    const url = base + '/api/artifacts/' + job.artifactId;
    const preview = await fetch(url + '/preview');
    const download = await fetch(url + '/download');
    const html = await preview.text();
    assert.equal(preview.status, 200);
    assert.ok(preview.headers.get('content-security-policy')?.includes('sandbox'));
    assert.equal(await download.text(), html);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal(html.match(/id="slide-/g)?.length, 4);
    assert.ok(html.includes(description.includes('<') ? '独立正文一 &lt;示例&gt;' : '独立正文二 &amp; 样例'));
  }
  assert.equal((await fetch(base + '/api/artifacts/missing/preview')).status, 404);
});

test('saving a summary captures its original text and citations in a complete artifact', async (t) => {
  const base = await listen(t, { model: { configured: true, async complete(_prompt, value) {
    const { fragments } = value as { fragments: Array<{ id: string; text: string }> };
    return { content: fragments[0].text, keyPoints: ['摘要要点'], citations: [fragments[0].id] };
  } } });
  const summary = await (await fetch(base + '/api/analysis', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ libraryIds: ['sample-writing'], version: 'one' }) })).json();
  const saved = await (await submit(base, { summaryId: summary.id })).json() as Job;
  assert.equal(saved.status, 'completed');
  assert.equal((await (await submit(base, { summaryId: summary.id })).json()).id, saved.id);
  const html = await (await fetch(base + '/api/artifacts/' + saved.artifactId + '/preview')).text();
  assert.ok(html.includes(summary.content) && html.includes(summary.citations[0].name));
  assert.equal((await submit(base, { summaryId: 'no-such-summary' })).status, 404);
  assert.equal((await (await fetch(base + '/api/jobs')).json()).items.length, 1);
});

test('writing produces structured documents and replaces unsupported notice metadata', async (t) => {
  const base = await listen(t, { model: { configured: true, async complete(_prompt, value) {
    const { description, mode } = value as { description: string; mode: string };
    const issuer = '示例编造单位';
    const date = '2099-01-01';
    const notice = mode === 'notice';
    return { title: notice ? issuer + '的通知' : description, issuer, date, sections: description === 'broken' ? [] : [{
      heading: notice ? '安排时间：2099 年 1 月 1 日' : '安排',
      paragraphs: [notice ? '文稿正文。Published by ' + issuer + ' on ' + date + '.' : '文稿正文'],
    }] };
  } } });
  for (const mode of ['general', 'notice']) {
    const { id } = await (await submit(base, { skill: 'writing', description: '写作样例', mode })).json();
    const job = await getJob(base, id);
    assert.equal(job.status, 'completed');
    const html = await (await fetch(base + '/api/artifacts/' + job.artifactId + '/preview')).text();
    assert.match(html, mode === 'notice' ? /写作样例/ : /文稿正文/);
    if (mode === 'notice') {
      assert.match(html, /待填写发文单位/);
      assert.match(html, /待填写日期/);
      assert.doesNotMatch(html, /示例编造单位|2099/);
      assert.doesNotMatch(job.title, /示例编造单位/);
    }
  }
  const { id } = await (await submit(base, { skill: 'writing', description: 'broken' })).json();
  assert.equal((await getJob(base, id)).status, 'failed');
});

test('notice placeholders use supplied facts and omit unsupported claims even when metadata is absent', async (t) => {
  const base = await listen(t, { model: { configured: true, async complete() {
    return { title: '活动通知 · {{issuer}}', sections: [{ heading: '签发日期：2026 年 5 月 3 日', paragraphs: [
      '发文单位：云山办公室。', '本通知由山海分部发布。', '活动日期：2099-01-01。', '请留意 {{date}}。',
    ] }] };
  } } });
  const { id } = await (await submit(base, { skill: 'writing', mode: 'notice', description: '撰写活动通知',
    issuer: '云山办公室', date: '2026-05-03' })).json();
  const job = await getJob(base, id);
  assert.equal(job.status, 'completed');
  const html = await (await fetch(base + '/api/artifacts/' + job.artifactId + '/download')).text();
  assert.match(html, /活动通知 · 云山办公室/);
  assert.match(html, /发文单位：云山办公室/);
  assert.match(html, /2026 年 5 月 3 日/);
  assert.match(html, /活动日期：【待填写日期】/);
  assert.match(html, /请留意 2026-05-03/);
  assert.doesNotMatch(html, /山海分部|2099|\{\{(?:issuer|date)\}\}/);
});

test('a notice cannot publish a made-up issuer or date in an unsupported title or free-text paragraph', async (t) => {
  const base = await listen(t, { model: { configured: true, async complete() {
    return { title: '山海会议中心通知', sections: [{ heading: '山海会议中心签发',
      paragraphs: ['山海会议中心谨此通知，发布日期为二〇九九年元旦。'] }] };
  } } });
  const description = '周末举办社区阅读活动';
  const { id } = await (await submit(base, { skill: 'writing', mode: 'notice', description })).json();
  const job = await getJob(base, id);
  assert.equal(job.status, 'completed');
  assert.equal(job.title, '活动通知');
  const html = await (await fetch(base + '/api/artifacts/' + job.artifactId + '/download')).text();
  assert.match(html, /周末举办社区阅读活动/);
  assert.match(html, /待填写发文单位/);
  assert.match(html, /待填写日期/);
  assert.doesNotMatch(html, /山海会议中心|二〇九九年元旦/);
});

test('a venue and an event date cannot be repurposed as notice signing information', async (t) => {
  const base = await listen(t, { model: { configured: true, async complete() {
    return { title: '活动通知', issuer: '云山会议中心', date: '2026-05-03', sections: [{ heading: '安排',
      paragraphs: ['活动日期：2026-05-03', '签发日期：2026-05-03', '发文单位：云山会议中心'] }] };
  } } });
  const { id } = await (await submit(base, { skill: 'writing', mode: 'notice',
    description: '活动日期：2026-05-03，地点为云山会议中心。' })).json();
  const job = await getJob(base, id);
  assert.equal(job.status, 'completed');
  const html = await (await fetch(base + '/api/artifacts/' + job.artifactId + '/download')).text();
  assert.match(html, /活动日期：2026-05-03/);
  assert.match(html, /签发日期：【待填写日期】/);
  assert.match(html, /发文单位：【待填写发文单位】/);
  assert.match(html, /<footer><p>【待填写发文单位】<\/p><p>【待填写日期】<\/p>/);
});

test('mind map saves an explicit hierarchy and rejects missing or over-limit nodes', async (t) => {
  const base = await listen(t, { model: { configured: true, async complete(_prompt, value) {
    const { description, maxNodes } = value as { description: string; maxNodes: number };
    const leaf = { title: '子节点', children: [] };
    return { root: { title: description || '有来源的导图', children: description === 'empty' ? [] : description === 'too many'
      ? Array.from({ length: maxNodes }, () => leaf) : [{ title: '分支', children: [leaf] }] } };
  } } });
  for (const body of [{ description: '样例脑图' }, { libraryIds: ['sample-writing'] }, { description: 'empty' }, { description: 'too many' }]) {
    const { id } = await (await submit(base, { skill: 'mindmap', ...body })).json();
    const job = await getJob(base, id);
    if (body.description === 'empty' || body.description === 'too many') {
      assert.equal(job.status, 'failed');
      continue;
    }
    assert.equal(job.status, 'completed');
    const html = await (await fetch(base + '/api/artifacts/' + job.artifactId + '/download')).text();
    assert.match(html, /<ul><li><span>分支<\/span><ul><li><span>子节点<\/span>/);
  }
});

test('timed-out and interrupted jobs remain failed while retry uses the original snapshot', async () => {
  const directory = await mkdtempDisposable(join(tmpdir(), 'workbench-job-restart-'));
  const databasePath = join(directory.path, 'workspace.sqlite');
  let hold = true;
  const options = { databasePath, jobTimeoutMs: 45, artifactSkills: { test: { async generate({ description }: { description: string }) {
    if (hold) await new Promise(() => {});
    return { title: description, content: { description }, html: '<p>Recovered</p>' };
  } } } };
  let app = createWorkbenchServer(options);
  try {
    let base = await app.listen({ host: loopbackHost, port: 0 });
    const { id } = await (await submit(base, { skill: 'test', description: 'Original snapshot' })).json();
    const timeout = await getJob(base, id);
    assert.equal(timeout.status, 'failed');
    assert.match(timeout.error ?? '', /超时/);
    await app.close();
    const fixture = new DatabaseSync(databasePath);
    try { fixture.prepare("UPDATE jobs SET status = 'generating' WHERE id = ?").run(id); }
    finally { fixture.close(); }
    hold = false;
    app = createWorkbenchServer(options);
    base = await app.listen({ host: loopbackHost, port: 0 });
    const interrupted = await getJob(base, id);
    assert.match(interrupted.error ?? '', /服务中断/);
    const retry = await fetch(base + '/api/jobs/' + id + '/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'retry-1', description: 'Ignored override' }) });
    assert.equal(retry.status, 202);
    const newJob = await retry.json() as Job;
    assert.notEqual(newJob.id, id);
    const completed = await getJob(base, newJob.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.title, 'Original snapshot');
    assert.equal((await getJob(base, id)).status, 'failed');
    const reconnect = await fetch(base + '/api/jobs/' + newJob.id + '/events');
    assert.match(await reconnect.text(), /"status":"completed"/);
  } finally { await app.close(); await directory.remove(); }
});

test('renaming preserves the artifact URL and delete rolls back when storage rejects it', async () => {
  const directory = await mkdtempDisposable(join(tmpdir(), 'workbench-job-delete-'));
  const databasePath = join(directory.path, 'workspace.sqlite');
  const app = createWorkbenchServer({ databasePath, artifactSkills: { test: { async generate() {
    return { title: '原名称', content: { text: 'Body' }, html: '<p>Body</p>' };
  } } } });
  try {
    const base = await app.listen({ host: loopbackHost, port: 0 });
    const { id } = await (await submit(base, { skill: 'test', description: 'original' })).json();
    const job = await getJob(base, id);
    const url = base + '/api/artifacts/' + job.artifactId;
    const rename = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '新的名称' }) });
    assert.equal(rename.status, 200);
    assert.equal((await rename.json()).artifactId, job.artifactId);
    const download = await fetch(url + '/download');
    assert.match(decodeURIComponent(download.headers.get('content-disposition') ?? ''), /新的名称\.html/);
    const fault = new DatabaseSync(databasePath);
    try {
      fault.exec("CREATE TRIGGER simulated_failure BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
      assert.equal((await fetch(base + '/api/jobs/' + id, { method: 'DELETE' })).status, 500);
      assert.equal((await fetch(url + '/preview')).status, 200);
      assert.equal((await getJob(base, id)).title, '新的名称');
      fault.exec('DROP TRIGGER simulated_failure');
    } finally { fault.close(); }
    assert.equal((await fetch(base + '/api/jobs/' + id, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(url + '/preview')).status, 404);
    assert.equal((await fetch(base + '/api/jobs/' + id)).status, 404);
  } finally { await app.close(); await directory.remove(); }
});

test('storage failures leave no completed artifact or orphaned saved summary', async () => {
  const directory = await mkdtempDisposable(join(tmpdir(), 'workbench-artifact-save-'));
  const databasePath = join(directory.path, 'workspace.sqlite');
  const app = createWorkbenchServer({ databasePath, model: { configured: true, async complete(_instruction, value) {
    const { fragments } = value as { fragments: Array<{ id: string }> };
    return { content: '有正文的摘要', keyPoints: ['摘要要点'], citations: [fragments[0].id] };
  } }, artifactSkills: { test: { async generate() { return { title: 'Ready draft', content: {}, html: '<p>Body</p>' }; } } } });
  try {
    const base = await app.listen({ host: loopbackHost, port: 0 });
    const fault = new DatabaseSync(databasePath);
    try { fault.exec("CREATE TRIGGER simulated_save_failure BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'simulated failure'); END"); }
    finally { fault.close(); }
    const submitted = await (await submit(base, { skill: 'test', description: 'Draft' })).json() as Job;
    const failed = await getJob(base, submitted.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.artifactId, null);
    const summary = await (await fetch(base + '/api/analysis', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryIds: ['sample-writing'] }) })).json();
    assert.equal((await submit(base, { summaryId: summary.id })).status, 500);
    const { items } = await (await fetch(base + '/api/jobs')).json();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, failed.id);
  } finally { await app.close(); await directory.remove(); }
});
