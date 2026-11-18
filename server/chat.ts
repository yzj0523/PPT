import type { FastifyInstance } from 'fastify';
import { AppError, SkillRegistry } from './ai.ts';
import type { ModelProvider } from './ai.ts';
import { citations, object, outputText, selection, text } from './context.ts';
import type { createContextBuilder, Fragment, Citation } from './context.ts';

type Message = { role: 'user' | 'assistant'; content: string; version: string | number };
type Answer = { content: string; citations: Citation[]; insufficient: boolean };

export function registerChat(app: FastifyInstance, skills: SkillRegistry, model: ModelProvider,
  buildContext: ReturnType<typeof createContextBuilder>) {
  skills.register('chat', async (input, provider) => {
    const body = input as { question: string; history: Message[]; fragments: Fragment[] };
    const result = object(await provider.complete(
      '回答 question。history 用于理解语境，有 fragments 时事实只来自 fragments。' +
      '若材料不足，直接说明。没有材料时按常规问答回答。返回 content、citations（片段 ID 数组）和 insufficient（布尔值）。', body,
    ));
    if (typeof result.insufficient !== 'boolean') throw new AppError(502, 'invalid_output', '模型回答格式错误。');
    return { content: outputText(result.content, 16000), insufficient: result.insufficient,
      citations: citations(result.citations, body.fragments, !result.insufficient) };
  });

  app.post('/api/chat', async (request) => {
    const input = object(request.body);
    const selected = selection(input);
    const question = text(input.question);
    if (!question) throw new AppError(400, 'empty_question', '请输入问题。');
    if (input.history !== undefined && !Array.isArray(input.history)) {
      throw new AppError(400, 'invalid_history', '对话历史格式错误。');
    }

    const recent = (Array.isArray(input.history) ? input.history.slice(-10) : []).map(object);
    // Old user messages can contain quotes of a previous answer too, so use only turns from this version.
    const history: Message[] = recent.flatMap((message) => {
      const { role, version } = message;
      if ((role !== 'user' && role !== 'assistant') || version !== selected.version) return [];
      return [{ role, version: selected.version, content: text(message.content, 16000).slice(0, 1500) }];
    });
    const query = [...history.filter(({ role }) => role === 'user').slice(-2).map(({ content }) => content), question].join(' ');
    const { fragments, partial } = buildContext(selected, query);
    if (!fragments.length && (selected.sourceIds.length || selected.libraryIds.length)) {
      return { content: '当前选择没有可引用的正文。', citations: [], insufficient: true, partial, version: selected.version };
    }
    const answer = await skills.run<Answer>('chat', { question, history, fragments }, model);
    return { ...answer, partial, version: selected.version };
  });
}
