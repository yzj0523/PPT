import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { SourceSection } from './sources/parse.ts';

export const personalLibraryId = 'my-materials';

export function inTransaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec('BEGIN');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function registerLibrary(app: FastifyInstance, database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_bases (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      library_id TEXT NOT NULL REFERENCES knowledge_bases(id), fingerprint TEXT NOT NULL,
      name TEXT NOT NULL, format TEXT NOT NULL, sections TEXT NOT NULL,
      PRIMARY KEY (library_id, fingerprint)
    );
  `);
  const addLibrary = database.prepare('INSERT OR IGNORE INTO knowledge_bases (id, name, description) VALUES (?, ?, ?)');
  const addDocument = database.prepare('INSERT OR IGNORE INTO knowledge_documents (library_id, fingerprint, name, format, sections) VALUES (?, ?, ?, ?, ?)');
  inTransaction(database, () => {
    addLibrary.run(personalLibraryId, '我的素材库', '上传时选择纳入知识库的文档。');
    addLibrary.run('sample-writing', '写作素材示例', '演示用的项目资料。');
    const sections = [
      { number: 1, text: '青禾社区阅读项目自 2024 年 4 月启动，每周六举办一次开放阅读活动。' },
      { number: 2, text: '报名地点为青禾社区服务中心。活动面向社区居民，免费参加。' },
    ];
    const body = JSON.stringify(sections);
    addDocument.run('sample-writing', createHash('sha256').update(body).digest('hex'), '青禾社区阅读项目（示例）', 'docx', body);
  });

  const list = database.prepare(`
    SELECT k.id, k.name, k.description, COUNT(d.fingerprint) AS documentCount
    FROM knowledge_bases k LEFT JOIN knowledge_documents d ON d.library_id = k.id
    GROUP BY k.id ORDER BY k.id
  `);
  app.get('/api/knowledge-bases', async () => ({ items: list.all() }));

  return (document: { fingerprint: string; name: string; format: string; sections: SourceSection[] }) => {
    addDocument.run(personalLibraryId, document.fingerprint, document.name, document.format, JSON.stringify(document.sections));
  };
}
