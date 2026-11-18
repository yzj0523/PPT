import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { AppError, SkillRegistry } from './ai.ts';
import type { ModelProvider } from './ai.ts';
import { citations, object, outputText, selection, text } from './context.ts';
import type { createContextBuilder, Fragment, Citation } from './context.ts';

export type Summary = { id: string; content: string; keyPoints: string[]; citations: Citation[]; version: string | number;
  partial: boolean; createdAt: string };

export function registerAnalysis(app: FastifyInstance, database: DatabaseSync, skills: SkillRegistry,
  model: ModelProvider, buildContext: ReturnType<typeof createContextBuilder>) {
  database.exec('CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, result TEXT NOT NULL)');
  const save = database.prepare('INSERT INTO analyses (id, result) VALUES (?, ?)');

  skills.register('summary', async (input, provider) => {
    const { fragments, requirements } = input as { fragments: Fragment[]; requirements: string };
    const output = object(await provider.complete(
      '总结所提供的材料。返回 content（摘要）、keyPoints（字符串数组）和 citations（使用的片段 ID 数组）。重要事实须来自材料。',
      { fragments, requirements },
    ));
    if (!Array.isArray(output.keyPoints) || !output.keyPoints.length || output.keyPoints.length > 20) {
      throw new AppError(502, 'invalid_output', '模型摘要缺少有效要点。');
    }
    return { content: outputText(output.content, 16000), keyPoints: output.keyPoints.map((point) => outputText(point, 1000)),
      citations: citations(output.citations, fragments, true) };
  });

  app.post('/api/analysis', async (request) => {
    const input = object(request.body);
    const selected = selection(input);
    const requirements = text(input.requirements);
    const { fragments, partial } = buildContext(selected);
    if (!fragments.length) throw new AppError(400, 'no_sources', '请选择含可用正文的来源。');
    const output = await skills.run<Pick<Summary, 'content' | 'keyPoints' | 'citations'>>('summary', { fragments, requirements }, model);
    const result: Summary = { ...output, id: randomUUID(), version: selected.version, partial, createdAt: new Date().toISOString() };
    save.run(result.id, JSON.stringify(result));
    return result;
  });
}
