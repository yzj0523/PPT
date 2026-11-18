import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { AppError, SkillRegistry } from './ai.ts';
import type { ModelProvider } from './ai.ts';
import type { Summary } from './analysis.ts';
import { object, outputText, selection, text } from './context.ts';
import type { createContextBuilder, Fragment } from './context.ts';
import { inTransaction } from './library.ts';
import { escapeHtml, htmlDocument } from './render.ts';

export type GenerationInput = { description: string; fragments: Fragment[]; partial: boolean; options: Record<string, unknown> };
export type ArtifactDraft = { title: string; content: unknown; html: string };
export type ArtifactSkill = {
  options?: (body: Record<string, unknown>) => Record<string, unknown>;
  generate: (input: GenerationInput, model: ModelProvider, signal?: AbortSignal) => Promise<ArtifactDraft>;
};

type JobStatus = 'queued' | 'generating' | 'completed' | 'failed';
export type Job = {
  id: string; skill: string; title: string; status: JobStatus; phase: string; error: string | null; artifactId: string | null;
  createdAt: string; updatedAt: string; sequence: number; partial: boolean;
};

export function registerJobs(app: FastifyInstance, database: DatabaseSync, skills: SkillRegistry,
  model: ModelProvider, buildContext: ReturnType<typeof createContextBuilder>, definitions: Record<string, ArtifactSkill>, timeoutMs: number) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, skill TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      phase TEXT NOT NULL, error TEXT, artifactId TEXT,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, sequence INTEGER NOT NULL,
      requestKey TEXT UNIQUE, input TEXT NOT NULL, partial INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, jobId TEXT NOT NULL UNIQUE REFERENCES jobs(id),
      title TEXT NOT NULL, content TEXT NOT NULL, html TEXT NOT NULL
    );
  `);
  for (const [name, definition] of Object.entries(definitions)) {
    skills.register(name, (input, provider, signal) => definition.generate(input as GenerationInput, provider, signal));
  }
  const insert = database.prepare(`
    INSERT INTO jobs (id, skill, title, status, phase, createdAt, updatedAt, sequence, requestKey, input, partial)
    VALUES (?, ?, ?, 'queued', '排队中', ?, ?, 1, ?, ?, ?)
  `);
  const addArtifact = database.prepare('INSERT INTO artifacts (id, jobId, title, content, html) VALUES (?, ?, ?, ?, ?)');
  const transitionJob = database.prepare(`
    UPDATE jobs SET status = ?, phase = ?, error = ?, artifactId = ?, title = COALESCE(?,title),
      updatedAt = ?, sequence = sequence + 1 WHERE id = ?
  `);
  const columns = 'id, skill, title, status, phase, error, artifactId, createdAt, updatedAt, sequence, partial';
  const find = database.prepare('SELECT ' + columns + ' FROM jobs WHERE id = ?');
  const findByKey = database.prepare('SELECT ' + columns + ' FROM jobs WHERE requestKey = ?');
  const list = database.prepare('SELECT ' + columns + ' FROM jobs ORDER BY createdAt DESC, rowid DESC');
  const pending = new Set<Promise<void>>();
  const findSummary = database.prepare('SELECT result FROM analyses WHERE id = ?');
  const findInput = database.prepare('SELECT input FROM jobs WHERE id = ?');
  const listeners = new Map<string, Set<(job: Job) => void>>();
  const streams = new Set<ServerResponse>();
  database.prepare(`UPDATE jobs SET status = 'failed', phase = '生成失败', error = ?, artifactId = NULL,
    updatedAt = ?, sequence = sequence + 1 WHERE status IN ('queued', 'generating')`)
    .run('服务中断，任务未完成。可以重试。', new Date().toISOString());

  function decode(row: unknown): Job | undefined {
    if (!row) return undefined;
    const job = row as Job;
    return { ...job, partial: Boolean(job.partial) };
  }

  function get(id: string) {
    const job = decode(find.get(id));
    if (!job) throw new AppError(404, 'job_not_found', '找不到该生成记录。');
    return job;
  }

  function transition(id: string, status: JobStatus, phase: string, error: string | null = null,
    artifactId: string | null = null, title: string | null = null) {
    transitionJob.run(status, phase, error, artifactId, title, new Date().toISOString(), id);
  }

  function publish(id: string) {
    const subscribers = listeners.get(id);
    if (subscribers?.size) {
      const job = get(id);
      for (const send of subscribers) send(job);
    }
  }

  async function run(job: Job, input: GenerationInput) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      transition(job.id, 'generating', '正在生成内容');
      publish(job.id);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new AppError(504, 'job_timeout', '生成任务超时，可以重试。'));
          controller.abort();
        }, timeoutMs);
      });
      const draft = await Promise.race([skills.run<ArtifactDraft>(job.skill, input, model, controller.signal), timeout]);
      const html = outputText(draft?.html, 500000);
      const title = outputText(draft.title, 150);
      transition(job.id, 'generating', '正在保存产物');
      publish(job.id);
      const artifactId = randomUUID();
      inTransaction(database, () => {
        addArtifact.run(artifactId, job.id, title, JSON.stringify(draft.content), html);
        transition(job.id, 'completed', '已完成', null, artifactId, title);
      });
      publish(job.id);
    } catch (error) {
      if (!(error instanceof AppError)) app.log.error({ err: error }, 'Cannot complete generation');
      transition(job.id, 'failed', '生成失败', error instanceof AppError ? error.message : '生成结果保存失败，请重试。');
      publish(job.id);
    } finally {
      clearTimeout(timer);
    }
  }

  function create(skill: string, input: GenerationInput, key: string | null) {
    if (key) {
      const existing = decode(findByKey.get(key));
      if (existing) return existing;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    insert.run(id, skill, input.description.slice(0, 70) || '正在生成', now, now, key, JSON.stringify(input), Number(input.partial));
    const job = get(id);
    const task = new Promise<void>((resolve) => setImmediate(resolve)).then(() => run(job, input))
      .catch((error) => app.log.error({ err: error }, 'Cannot update generation status'));
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return job;
  }

  function saveSummary(summaryId: string) {
    const key = 'summary:' + summaryId;
    const existing = decode(findByKey.get(key));
    if (existing) return existing;
    const row = findSummary.get(summaryId) as { result: string } | undefined;
    if (!row) throw new AppError(404, 'summary_not_found', '找不到当前摘要，请重新分析。');
    const summary = JSON.parse(row.result) as Summary;
    const title = '文档摘要 · ' + summary.content.slice(0, 42);
    const refs = summary.citations.map(({ name, number, format, library }) => '<li>' + escapeHtml(
      (library ? library + ' · ' : '') + name + ' · 第 ' + number + (format === 'pdf' ? ' 页' : ' 段'),
    ) + '</li>').join('');
    const html = htmlDocument(title, '<h1>文档摘要</h1><p>' + escapeHtml(summary.content) + '</p><h2>要点</h2><ul>' +
      summary.keyPoints.map((point) => '<li>' + escapeHtml(point) + '</li>').join('') + '</ul><h2>引用来源</h2><ul>' + refs + '</ul>' +
      (summary.partial ? '<p>本次使用了部分材料。</p>' : ''));
    const id = randomUUID();
    const artifactId = randomUUID();
    const now = new Date().toISOString();
    inTransaction(database, () => {
      insert.run(id, 'summary', title, now, now, key, '{}', Number(summary.partial));
      addArtifact.run(artifactId, id, title, row.result, html);
      transition(id, 'completed', '已完成', null, artifactId, title);
    });
    return get(id);
  }

  app.post('/api/jobs', async (request, reply) => {
    const body = object(request.body);
    if (body.summaryId !== undefined) {
      const summaryId = text(body.summaryId, 100);
      if (!summaryId) throw new AppError(400, 'invalid_summary', '请指定要保存的摘要。');
      return reply.code(202).send(saveSummary(summaryId));
    }
    const skill = text(body.skill, 40);
    const definition = Object.hasOwn(definitions, skill) ? definitions[skill] : undefined;
    if (!definition) throw new AppError(400, 'unknown_skill', '不支持该生成类型。');
    const submittedKey = text(body.idempotencyKey, 100);
    const key = submittedKey ? 'generation:' + submittedKey : null;
    if (key) {
      const existing = decode(findByKey.get(key));
      if (existing) return reply.code(202).send(existing);
    }
    const description = text(body.description);
    const { fragments, partial } = buildContext(selection(body), description);
    if (!description && !fragments.length) throw new AppError(400, 'empty_generation', '请选择可用来源或填写生成要求。');
    const options = definition.options?.(body) ?? {};
    return reply.code(202).send(create(skill, { description, fragments, partial, options }, key));
  });
  app.get('/api/jobs', async () => ({ items: list.all().map(decode) }));
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request) => get(request.params.id));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request, reply) => {
    const job = get(request.params.id);
    if (job.status !== 'failed' || !Object.hasOwn(definitions, job.skill)) {
      throw new AppError(409, 'job_not_retryable', '只有失败的生成任务可以重试。');
    }
    const input = findInput.get(job.id) as { input: string };
    const key = text(object(request.body).idempotencyKey, 100);
    return reply.code(202).send(create(job.skill, JSON.parse(input.input) as GenerationInput, key ? 'retry:' + job.id + ':' + key : null));
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', async (request, reply) => {
    const { id } = request.params;
    const initial = get(id);
    const response = reply.raw;
    reply.hijack();
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no' });
    streams.add(response);
    const subscribers = listeners.get(id) ?? new Set<(job: Job) => void>();
    listeners.set(id, subscribers);
    const send = (job: Job) => {
      response.write('id: ' + job.sequence + '\ndata: ' + JSON.stringify(job) + '\n\n');
      if (job.status === 'completed' || job.status === 'failed') response.end();
    };
    subscribers.add(send);
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15_000);
    response.on('close', () => {
      clearInterval(heartbeat);
      streams.delete(response);
      subscribers.delete(send);
      if (!subscribers.size) listeners.delete(id);
    });
    send(initial);
  });

  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
  });

  return { get, finish: () => Promise.allSettled(pending) };
}
