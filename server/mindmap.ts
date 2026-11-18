import { AppError } from './ai.ts';
import { object, outputText } from './context.ts';
import type { ArtifactSkill } from './jobs.ts';
import { escapeHtml, htmlDocument } from './render.ts';

type Node = { title: string; children: Node[] };

export function createMindMapSkill(maxDepth: number, maxNodes: number): ArtifactSkill {
  if (!Number.isSafeInteger(maxDepth) || !Number.isSafeInteger(maxNodes) || maxDepth < 2 || maxDepth > 30 || maxNodes < 2 || maxNodes > 1000) {
    throw new Error('脑图配置超出范围。深度应为 2–30，节点数应为 2–1000。');
  }

  return { async generate({ description, fragments, partial }, model, signal) {
    const result = object(await model.complete(
      '生成中文思维导图。仅返回 { root: { title, children } }。每个节点有非空 title 和子节点数组。' +
      '根节点至少有一个分支。遵循 description 与 fragments，遵守 maxDepth 和 maxNodes。',
      { description, fragments, maxDepth, maxNodes }, signal,
    ));
    let nodes = 0;
    function read(value: unknown, depth: number): Node {
      const item = object(value);
      nodes += 1;
      if (depth > maxDepth || nodes > maxNodes || !Array.isArray(item.children)) {
        throw new AppError(502, 'invalid_mindmap', '模型返回的导图结构错误或超出层级与节点上限。');
      }
      return { title: outputText(item.title, 150), children: item.children.map((child) => read(child, depth + 1)) };
    }
    const root = read(result.root, 1);
    if (!root.children.length) throw new AppError(502, 'invalid_mindmap', '脑图至少需要一个分支。');
    function branches(items: Node[]): string {
      if (!items.length) return '';
      return '<ul>' + items.map(({ title, children }) => '<li><span>' + escapeHtml(title) + '</span>' + branches(children) + '</li>').join('') + '</ul>';
    }
    const body = '<h1>' + escapeHtml(root.title) + '</h1>' + (partial ? '<p>本次使用了部分材料。</p>' : '') + branches(root.children);
    return { title: root.title, content: root, html: htmlDocument(root.title, body,
      'ul{list-style:none;border-inline-start:2px solid #b7cec2;padding-inline-start:18px;margin-block:16px}' +
      'li{margin-block:12px}li>span{display:inline-block;padding:5px 10px;background:white;border-radius:6px;border:1px solid #d9e4de}') };
  } };
}
