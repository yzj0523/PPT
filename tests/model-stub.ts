import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

const server = createServer(async (request, response) => {
  if (request.url === '/health') { response.end('ready'); return; }
  if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk.toString();
  try {
    const body = JSON.parse(raw);
    const input = JSON.parse(body.messages[1].content);
    const citations = input.fragments?.slice(0, 1).map(({ id }: { id: string }) => id) ?? [];
    if (typeof input.description === 'string' && input.description.startsWith('测试生成失败')) { response.writeHead(502).end(); return; }
    let content: object;
    if (input.minSlides) {
      await setTimeout(125);
      content = { title: '演讲文稿示例', slides: Array.from({ length: input.minSlides }, (_, index) => (
        { title: '第 ' + (index + 1) + ' 页', points: [input.description || input.fragments[0].text] }
      )) };
    } else if (input.maxDepth) {
      content = { root: { title: input.description || '来源脑图', children: [{ title: '一个分支', children: [
        { title: '分支下的子节点', children: [] },
      ] }] } };
    } else if (input.mode) {
      content = { title: input.description || '来源文稿', sections: [{ heading: '正文', paragraphs: [input.description || input.fragments[0].text] }] };
    } else if (input.question) {
      content = { content: '回答 · ' + input.question, citations, insufficient: false };
    } else {
      content = { content: input.fragments.map(({ text }: { text: string }) => text).join('\n'), keyPoints: ['依据所选材料'],
        citations: input.fragments.slice(0, 10).map(({ id }: { id: string }) => id) };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  } catch {
    response.writeHead(400).end();
  }
});

server.listen(5213, '127.0.0.1');
