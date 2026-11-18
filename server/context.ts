import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './ai.ts';
import type { SourceSection } from './sources/parse.ts';

export type Selection = { sourceIds: string[]; libraryIds: string[]; version: string | number };
export type Citation = { id: string; name: string; format: string; number: number; library?: string };
export type Fragment = Citation & { text: string };
type Document = { fingerprint: string; name: string; format: string; sections: string; library?: string };

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function text(value: unknown, max = 4000) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) throw new AppError(400, 'invalid_input', '输入内容格式错误或过长。');
  return value.trim();
}

export function selection(value: unknown): Selection {
  const input = object(value);
  function ids(list: unknown) {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 1000 || list.some((id) => typeof id !== 'string' || !id || id.length > 100)) {
      throw new AppError(400, 'invalid_sources', '来源列表格式错误。');
    }
    return [...new Set(list as string[])];
  }
  const version = input.version ?? '';
  if ((typeof version !== 'string' && typeof version !== 'number') || String(version).length > 100000) {
    throw new AppError(400, 'invalid_version', '来源版本格式错误。');
  }
  return { sourceIds: ids(input.sourceIds), libraryIds: ids(input.libraryIds), version };
}

function terms(value: string) {
  const words = value.toLowerCase().match(/[a-z0-9]+|\p{Script=Han}{2}|\p{Script=Han}/gu) ?? [];
  return [...new Set(words)].slice(0, 100);
}

export function createContextBuilder(database: DatabaseSync, maxCharacters: number) {
  const getSource = database.prepare("SELECT fingerprint, name, format, sections FROM sources WHERE id = ? AND status = 'ready'");
  const getLibrary = database.prepare(`
    SELECT d.fingerprint, d.name, d.format, d.sections, k.name AS library
    FROM knowledge_documents d JOIN knowledge_bases k ON k.id = d.library_id WHERE k.id = ? ORDER BY d.fingerprint
  `);

  return (selected: Selection, query = '') => {
    const documents = new Map<string, Document>();
    for (const id of selected.sourceIds) {
      const document = getSource.get(id) as Document | undefined;
      if (document) documents.set(document.fingerprint, documents.get(document.fingerprint) ?? document);
    }
    for (const id of selected.libraryIds) {
      for (const document of getLibrary.all(id) as Document[]) {
        const previous = documents.get(document.fingerprint);
        if (previous && !previous.library) previous.library = document.library;
        else if (!previous) documents.set(document.fingerprint, document);
      }
    }

    const chunkSize = query ? 800 : Math.max(1, Math.min(800, Math.floor(maxCharacters / Math.max(1, documents.size))));
    const groups = [...documents.values()].map((document) => {
      const sections = JSON.parse(document.sections) as SourceSection[];
      return sections.flatMap(({ number, text }) => {
        const fragments = [];
        for (let start = 0; start < text.length; start += chunkSize) {
          fragments.push({ id: '', name: document.name, format: document.format, number, library: document.library,
            text: text.slice(start, start + chunkSize) });
        }
        return fragments;
      });
    }).filter((group) => group.length);

    let ordered: Fragment[];
    if (query) {
      const keywords = terms(query);
      ordered = groups.flat().map((fragment) => {
        const content = fragment.text.toLowerCase();
        return { fragment, score: keywords.filter((keyword) => content.includes(keyword)).length };
      }).sort((left, right) => right.score - left.score).map(({ fragment }) => fragment);
    } else {
      ordered = [];
      for (let offset = 0; groups.some((group) => offset < group.length); offset += 1) {
        for (const group of groups) if (group[offset]) ordered.push(group[offset]);
      }
    }

    let remaining = maxCharacters;
    const fragments: Fragment[] = [];
    for (const fragment of ordered) {
      if (remaining <= 0) break;
      const snippet = fragment.text.slice(0, remaining);
      fragments.push({ ...fragment, text: snippet, id: 's' + (fragments.length + 1) });
      remaining -= snippet.length;
    }
    return { fragments, partial: ordered.length > fragments.length || remaining === 0 &&
      ordered[fragments.length - 1]?.text.length > fragments[fragments.length - 1]?.text.length };
  };
}

export function outputText(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AppError(502, 'invalid_output', '模型结果缺少有效内容。');
  }
  return value.trim();
}

export function citations(value: unknown, fragments: Fragment[], required: boolean): Citation[] {
  if (!Array.isArray(value) || value.length > 100 || (required && fragments.length > 0 && !value.length)) {
    throw new AppError(502, 'invalid_citations', '模型结果缺少有效引用。');
  }
  const allowed = new Map(fragments.map(({ text: _text, ...fragment }) => [fragment.id, fragment]));
  return [...new Set(value)].map((id) => {
    const citation = allowed.get(id);
    if (!citation) throw new AppError(502, 'invalid_citations', '模型引用不属于本次使用的来源。');
    return citation;
  });
}
