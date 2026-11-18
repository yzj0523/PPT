import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { AppError } from './ai.ts';
import { object, text } from './context.ts';
import type { Job } from './jobs.ts';
import { inTransaction } from './library.ts';

export function registerArtifacts(app: FastifyInstance, database: DatabaseSync, getJob: (id: string) => Job) {
  const get = database.prepare('SELECT id, jobId, title, html FROM artifacts WHERE id = ?');
  const renameArtifact = database.prepare('UPDATE artifacts SET title = ? WHERE id = ?');
  const renameJob = database.prepare('UPDATE jobs SET title = ?, updatedAt = ?, sequence = sequence + 1 WHERE id = ?');
  const deleteArtifact = database.prepare('DELETE FROM artifacts WHERE jobId = ?');
  const deleteJob = database.prepare('DELETE FROM jobs WHERE id = ?');
  for (const action of ['preview', 'download'] as const) {
    app.get<{ Params: { id: string } }>('/api/artifacts/:id/' + action, async (request, reply) => {
      const row = get.get(request.params.id) as { title: string; html: string } | undefined;
      if (!row) throw new AppError(404, 'artifact_not_found', '找不到可用的生成产物。');
      if (action === 'download') {
        const title = row.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100)
          .replace(/[. ]+$/, '').replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
        const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(title);
        const filename = (reserved ? '_' + title : title || '生成产物') + '.html';
        const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16));
        reply.header('Content-Disposition', "attachment; filename=artifact.html; filename*=UTF-8''" + encoded);
      }
      return reply.type('text/html; charset=utf-8').headers({
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      }).send(row.html);
    });
  }

  app.patch<{ Params: { id: string } }>('/api/artifacts/:id', async (request) => {
    const { id } = request.params;
    const title = text(object(request.body).title, 150);
    if (!title) throw new AppError(400, 'invalid_title', '请输入新标题。');
    const row = get.get(id) as { jobId: string } | undefined;
    if (!row) throw new AppError(404, 'artifact_not_found', '找不到可用的生成产物。');
    inTransaction(database, () => {
      renameArtifact.run(title, id);
      renameJob.run(title, new Date().toISOString(), row.jobId);
    });
    return getJob(row.jobId);
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const job = getJob(request.params.id);
    if (job.status === 'queued' || job.status === 'generating') {
      throw new AppError(409, 'job_active', '生成中的任务完成后才能删除。');
    }
    inTransaction(database, () => {
      deleteArtifact.run(job.id);
      deleteJob.run(job.id);
    });
    return reply.code(204).send();
  });
}
