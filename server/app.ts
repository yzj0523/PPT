import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { AppError, createModelProvider, SkillRegistry } from './ai.ts';
import type { ModelProvider } from './ai.ts';
import { registerAnalysis } from './analysis.ts';
import { registerArtifacts } from './artifacts.ts';
import { registerChat } from './chat.ts';
import { createContextBuilder } from './context.ts';
import { registerJobs } from './jobs.ts';
import type { ArtifactSkill } from './jobs.ts';
import { pptSkill } from './ppt.ts';
import { writingSkill } from './writing.ts';
import { createMindMapSkill } from './mindmap.ts';
import { registerLibrary } from './library.ts';
import { defaultDocxUnpackedBytes } from './sources/parse.ts';
import { registerSourceRoutes } from './sources/routes.ts';
import { defaultStagingBytes, reclaimInterruptedUploads } from './sources/staging.ts';

export const loopbackHost = '127.0.0.1';

const defaultDatabasePath = fileURLToPath(new URL('../data/workspace.sqlite', import.meta.url));

type WorkbenchOptions = {
  databasePath?: string;
  staticRoot?: string;
  maxDocxUnpackedBytes?: number;
  maxSourceStagingBytes?: number;
  model?: ModelProvider;
  maxContextCharacters?: number;
  artifactSkills?: Record<string, ArtifactSkill>;
  jobTimeoutMs?: number;
};

export function createWorkbenchServer({
  databasePath = process.env.WORKBENCH_DB_PATH || defaultDatabasePath,
  staticRoot,
  maxDocxUnpackedBytes = Number(process.env.WORKBENCH_DOCX_MAX_UNPACKED_BYTES ?? defaultDocxUnpackedBytes),
  maxSourceStagingBytes = Number(process.env.WORKBENCH_SOURCE_STAGING_BYTES ?? defaultStagingBytes),
  model = createModelProvider(),
  maxContextCharacters = Number(process.env.WORKBENCH_CONTEXT_CHARACTERS ?? 20000),
  artifactSkills = {},
  jobTimeoutMs = Number(process.env.WORKBENCH_JOB_TIMEOUT_MS ?? 90000),
}: WorkbenchOptions = {}) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    return reply.send(error);
  });

  app.register(async function localWorkspace(workspace) {
    if (!Number.isSafeInteger(maxDocxUnpackedBytes) || maxDocxUnpackedBytes < 1) {
      throw new Error('WORKBENCH_DOCX_MAX_UNPACKED_BYTES 必须为正整数字节数。');
    }
    if (!Number.isSafeInteger(maxSourceStagingBytes) || maxSourceStagingBytes < 1) {
      throw new Error('WORKBENCH_SOURCE_STAGING_BYTES 必须为正整数字节数。');
    }
    if (!Number.isSafeInteger(maxContextCharacters) || maxContextCharacters < 1) {
      throw new Error('WORKBENCH_CONTEXT_CHARACTERS 必须为正整数。');
    }
    if (!Number.isSafeInteger(jobTimeoutMs) || jobTimeoutMs < 1 || jobTimeoutMs > 2147483647) {
      throw new Error('WORKBENCH_JOB_TIMEOUT_MS 必须为有效的正整数毫秒数。');
    }
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    const database = new DatabaseSync(databasePath);
    try {
      if (databasePath !== ':memory:') {
        database.exec('PRAGMA journal_mode = WAL');
      }
      const addToLibrary = registerLibrary(workspace, database);
      await reclaimInterruptedUploads().catch((error) => workspace.log.warn({ err: error }, 'Cannot reclaim interrupted uploads'));
      const finishSourceImports = registerSourceRoutes(workspace, database,
        { docxBytes: maxDocxUnpackedBytes, stagingBytes: maxSourceStagingBytes }, addToLibrary);
      const skills = new SkillRegistry();
      const buildContext = createContextBuilder(database, maxContextCharacters);
      registerAnalysis(workspace, database, skills, model, buildContext);
      registerChat(workspace, skills, model, buildContext);
      const mindmap = createMindMapSkill(Number(process.env.WORKBENCH_MAP_MAX_DEPTH ?? 6), Number(process.env.WORKBENCH_MAP_MAX_NODES ?? 120));
      const jobs = registerJobs(workspace, database, skills, model, buildContext,
        { ppt: pptSkill, writing: writingSkill, mindmap, ...artifactSkills }, jobTimeoutMs);
      registerArtifacts(workspace, database, jobs.get);
      workspace.addHook('onClose', async () => {
        try {
          await finishSourceImports();
          await jobs.finish();
        } finally {
          database.close();
        }
      });
    } catch (error) {
      database.close();
      throw error;
    }
  });

  app.get('/api/health', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', modelConfigured: model.configured };
  });

  if (staticRoot) {
    app.register(fastifyStatic, { root: staticRoot });
  }

  return app;
}
