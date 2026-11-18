import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createModelProvider } from '../server/ai.ts';
import { createWorkbenchServer, loopbackHost } from '../server/app.ts';

test('the loopback API becomes healthy with an initialized workspace database', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'writing-workbench-'));
  const databasePath = join(temporaryDirectory, 'workspace', 'writing.sqlite');
  const app = createWorkbenchServer({ databasePath, model: createModelProvider({}) });
  t.after(async () => {
    await app.close();
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(databasePath, { force: true });
    await rmdir(dirname(databasePath));
    await rmdir(temporaryDirectory);
  });

  const address = await app.listen({ host: loopbackHost, port: 0 });
  assert.equal(new URL(address).hostname, '127.0.0.1');

  const response = await fetch(`${address}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', modelConfigured: false });

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  } finally {
    database.close();
  }
});
