import { createHash, randomUUID } from 'node:crypto';
import { rmdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import multipart from '@fastify/multipart';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { inTransaction } from '../library.ts';
import { maxSourceFileBytes, parseSource, SourceParseError, sourceError } from './parse.ts';
import type { SourceFormat, SourceSection } from './parse.ts';
import { createStagingBudget, newStagingDirectory } from './staging.ts';
import type { StagedFile } from './staging.ts';

type Source = {
  id: string;
  name: string;
  format: SourceFormat | null;
  status: 'parsing' | 'ready' | 'failed';
  error: ReturnType<typeof sourceError> | null;
};

type SourceRow = Omit<Source, 'error'> & { error_code: Parameters<typeof sourceError>[0] | null };
type Upload = { source: Source; file?: StagedFile };

function failed(source: Source, code: Parameters<typeof sourceError>[0]): Source {
  return { ...source, status: 'failed', error: sourceError(code) };
}

async function stageUpload(part: MultipartFile, directory: string, stage: ReturnType<typeof createStagingBudget>): Promise<Upload> {
  const filename = typeof part.filename === 'string' ? part.filename.trim() : '';
  const extension = extname(filename).toLowerCase();
  const format = extension === '.pdf' ? 'pdf' : extension === '.docx' ? 'docx' : null;
  const source: Source = { id: randomUUID(), name: filename ? part.filename : '未命名文件', format, status: 'parsing', error: null };
  if (!format) {
    for await (const _chunk of part.file) { /* Drain the part before reading the next file. */ }
    return { source: failed(source, filename ? 'unsupported_format' : 'missing_filename') };
  }

  const result = await stage(part, join(directory, source.id));
  return 'file' in result ? { source, file: result.file } : { source: failed(source, result.error) };
}

async function removeUploadBatch(directory: string, uploads: Upload[]) {
  await Promise.all(uploads.map(({ file }) => file?.remove()));
  await rmdir(directory);
}

export function registerSourceRoutes(app: FastifyInstance, database: DatabaseSync, limits: { docxBytes: number; stagingBytes: number },
  addToLibrary: (document: { fingerprint: string; name: string; format: string; sections: SourceSection[] }) => void) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      format TEXT,
      status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
      error_code TEXT,
      fingerprint TEXT,
      sections TEXT
    )
  `);

  const insert = database.prepare(`
    INSERT INTO sources (id, name, format, status, error_code, fingerprint, sections)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const select = database.prepare('SELECT id, name, format, status, error_code FROM sources WHERE id = ?');
  const remove = database.prepare('DELETE FROM sources WHERE id = ?');
  const activeSources = new Map<string, Source>();
  const stagedFiles = new Map<string, StagedFile>();
  const stage = createStagingBudget(limits.stagingBytes);
  let queued = Promise.resolve();

  function save(source: Source, fingerprint: string | null = null, sections: SourceSection[] | null = null) {
    insert.run(source.id, source.name, source.format, source.status, source.error?.code ?? null,
      fingerprint, sections ? JSON.stringify(sections) : null);
  }

  async function processUpload({ source, file }: Upload, includeInLibrary: boolean) {
    if (!file || !source.format || !activeSources.has(source.id)) return;

    let result: Source;
    let fingerprint: string | null = null;
    let sections: SourceSection[] | null = null;
    try {
      const bytes = await file.take();
      sections = await parseSource(bytes, source.format, limits.docxBytes);
      fingerprint = createHash('sha256').update(bytes).digest('hex');
      result = { ...source, status: 'ready' };
    } catch (error) {
      if (!(error instanceof SourceParseError)) app.log.error({ err: error }, 'Cannot read staged source');
      result = failed(source, error instanceof SourceParseError ? error.code : 'parse_failed');
    } finally {
      stagedFiles.delete(source.id);
    }

    // A source removed during parsing must not be restored by a late result.
    if (!activeSources.delete(source.id)) return;
    try {
      if (includeInLibrary && fingerprint && sections) {
        const document = { fingerprint, sections, name: source.name, format: source.format };
        inTransaction(database, () => {
          save(result, document.fingerprint, document.sections);
          addToLibrary(document);
        });
      } else {
        save(result, fingerprint, sections);
      }
    } catch (error) {
      app.log.error({ err: error }, 'Cannot save parsed source');
      activeSources.set(source.id, failed(source, 'parse_failed'));
    }
  }

  app.register(multipart, {
    limits: { fileSize: maxSourceFileBytes + 1 },
    throwFileSizeLimit: false,
  });

  app.post('/api/sources', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(415).send({ error: { code: 'multipart_required', message: '请以 multipart/form-data 上传文件。' } });
    }

    const directory = await newStagingDirectory();
    const uploads: Upload[] = [];
    let includeInLibrary = false;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') uploads.push(await stageUpload(part, directory, stage));
        else if (part.fieldname === 'includeInLibrary') includeInLibrary = part.value === 'true';
      }
      if (!uploads.length) {
        await removeUploadBatch(directory, uploads);
        return reply.code(400).send({ error: { code: 'no_files', message: '请至少上传一个文件。' } });
      }

      inTransaction(database, () => {
        for (const { source } of uploads) {
          if (source.status === 'failed') save(source);
        }
      });
    } catch (error) {
      await removeUploadBatch(directory, uploads);
      throw error;
    }

    for (const { source, file } of uploads) {
      if (file) {
        activeSources.set(source.id, source);
        stagedFiles.set(source.id, file);
      }
    }
    queued = queued.then(async () => {
      try {
        for (const upload of uploads) await processUpload(upload, includeInLibrary);
      } finally {
        await removeUploadBatch(directory, uploads);
      }
    }).catch((error) => app.log.error({ err: error }, 'Cannot finish source upload batch'));

    return reply.code(202).send({ items: uploads.map(({ source }) => source) });
  });

  const missing = { error: { code: 'source_not_found', message: '找不到指定的来源。' } };

  app.get<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    const { id } = request.params;
    const active = activeSources.get(id);
    if (active) return active;

    const row = select.get(id) as SourceRow | undefined;
    if (!row) return reply.code(404).send(missing);
    const { error_code, ...source } = row;
    return { ...source, error: error_code ? sourceError(error_code) : null };
  });

  app.delete<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    const { id } = request.params;
    if (!activeSources.delete(id) && !remove.run(id).changes) {
      return reply.code(404).send(missing);
    }
    const stagedFile = stagedFiles.get(id);
    stagedFiles.delete(id);
    if (stagedFile) {
      await stagedFile.remove().catch((error) => app.log.error({ err: error }, 'Cannot remove staged source'));
    }
    return reply.code(204).send();
  });

  return () => queued;
}
