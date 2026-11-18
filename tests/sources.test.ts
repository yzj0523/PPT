import assert from 'node:assert/strict';
import { access, mkdtemp, mkdtempDisposable, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import JSZip from 'jszip';
import { makeDocx, makePdf } from './documents.ts';
import { createWorkbenchServer, loopbackHost } from '../server/app.ts';
import { defaultDocxUnpackedBytes, maxSourceFileBytes, parseSource } from '../server/sources/parse.ts';

type SourceReply = {
  id: string;
  name: string;
  format: 'pdf' | 'docx' | null;
  status: 'parsing' | 'ready' | 'failed';
  error: { code: string; message: string } | null;
};

async function startServer(t: TestContext, maxDocxUnpackedBytes?: number) {
  const app = createWorkbenchServer({ databasePath: ':memory:', maxDocxUnpackedBytes });
  t.after(() => app.close());
  return app.listen({ host: loopbackHost, port: 0 });
}

async function uploadFiles(address: string, files: Array<[name: string, bytes: Buffer]>, includeInLibrary = false) {
  const form = new FormData();
  for (const [name, bytes] of files) {
    form.append('files', new Blob([new Uint8Array(bytes)]), name);
  }
  form.append('includeInLibrary', String(includeInLibrary));
  const response = await fetch(`${address}/api/sources`, { method: 'POST', body: form });
  assert.equal(response.status, 202, await response.clone().text());
  return (await response.json() as { items: SourceReply[] }).items;
}

async function readCompletedSource(address: string, id: string): Promise<SourceReply> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${address}/api/sources/${id}`);
    assert.equal(response.status, 200);
    const source = await response.json() as SourceReply;
    if (source.status !== 'parsing') return source;
    await setTimeout(20);
  }
  assert.fail(`Timed out waiting for source ${id}`);
}

test('a multipart batch reports independent states for valid, empty, corrupt, mismatched and unsupported files', async (t) => {
  const address = await startServer(t);
  const pdf = makePdf(['A valid page']);
  const docx = await makeDocx([['正文内容']]);
  const otherZip = new JSZip();
  otherZip.file('contents.txt', 'This ZIP is not a document.');
  const zipBytes = await otherZip.generateAsync({ type: 'nodebuffer' });

  const files: Array<[string, Buffer]> = [
    ['too large.pdf', Buffer.alloc(maxSourceFileBytes + 32)],
    ['会议 纪要.PDF', pdf],
    ['项目 说明.DOCX', docx],
    ['old.doc', docx],
    ['empty.pdf', makePdf([''])],
    ['empty.docx', await makeDocx([[], []])],
    ['damaged.pdf', Buffer.from('%PDF-1.7\ncorrupt')],
    ['damaged.docx', docx.subarray(0, 32)],
    ['wrong extension.pdf', docx],
    ['ordinary zip.docx', zipBytes],
    ['会议 纪要.PDF', pdf],
  ];
  const accepted = await uploadFiles(address, files);
  assert.deepEqual(accepted.map(({ name }) => name), files.map(([name]) => name));
  assert.equal(new Set(accepted.map(({ id }) => id)).size, files.length);
  assert.equal(accepted[1].status, 'parsing');
  assert.equal(accepted[2].status, 'parsing');

  const results = await Promise.all(accepted.map(({ id }) => readCompletedSource(address, id)));
  assert.deepEqual(results.map(({ format, status, error }) => [format, status, error?.code ?? null]), [
    ['pdf', 'failed', 'file_too_large'],
    ['pdf', 'ready', null],
    ['docx', 'ready', null],
    [null, 'failed', 'unsupported_format'],
    ['pdf', 'failed', 'empty_text'],
    ['docx', 'failed', 'empty_text'],
    ['pdf', 'failed', 'invalid_file'],
    ['docx', 'failed', 'invalid_file'],
    ['pdf', 'failed', 'format_mismatch'],
    ['docx', 'failed', 'format_mismatch'],
    ['pdf', 'ready', null],
  ]);
  assert.ok(results.filter(({ status }) => status === 'failed').every(({ error }) => error?.message));
  assert.deepEqual(results.map(({ id }) => id), accepted.map(({ id }) => id));

  const deleted = await fetch(`${address}/api/sources/${results[1].id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal((await fetch(`${address}/api/sources/${results[1].id}`)).status, 404);
  assert.equal((await readCompletedSource(address, results[10].id)).status, 'ready');
});

test('encrypted PDFs and page or unpacking limits report separate errors over HTTP', async (t) => {
  const address = await startServer(t, 4096);
  const protectedPdf = await readFile(new URL('./fixtures/password-protected.pdf', import.meta.url));
  const emptyPasswordPdf = await readFile(new URL('./fixtures/encrypted-empty-password.pdf', import.meta.url));
  const pages = Array<string>(201).fill('');
  pages[0] = 'A valid page';

  const accepted = await uploadFiles(address, [
    ['protected.pdf', protectedPdf],
    ['empty-password.pdf', emptyPasswordPdf],
    ['many pages.pdf', makePdf(pages)],
    ['allowed pages.pdf', makePdf(pages.slice(0, 200))],
    ['large archive.docx', await makeDocx([['A valid paragraph']], 'X'.repeat(5000))],
    ['normal archive.docx', await makeDocx([['A valid paragraph']])],
  ]);
  const results = await Promise.all(accepted.map(({ id }) => readCompletedSource(address, id)));
  assert.deepEqual(results.map(({ status, error }) => [status, error?.code ?? null]), [
    ['failed', 'encrypted_file'],
    ['failed', 'encrypted_file'],
    ['failed', 'pdf_page_limit'],
    ['ready', null],
    ['failed', 'docx_unpack_limit'],
    ['ready', null],
  ]);
});

test('removing a queued source keeps it unavailable when the batch finishes', async (t) => {
  const address = await startServer(t);
  const delayedPdf = makePdf(Array<string>(200).fill('A page'));
  const [first, removed, last] = await uploadFiles(address, [
    ['first.pdf', delayedPdf],
    ['removed.pdf', makePdf(['This source is removed'])],
    ['last.pdf', makePdf(['This source completes'])],
  ]);

  assert.equal((await fetch(`${address}/api/sources/${removed.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await readCompletedSource(address, first.id)).status, 'ready');
  assert.equal((await readCompletedSource(address, last.id)).status, 'ready');
  assert.equal((await fetch(`${address}/api/sources/${removed.id}`)).status, 404);
});

test('the sources endpoints reject requests with no files and unknown source IDs', async (t) => {
  const address = await startServer(t);
  const form = new FormData();
  form.append('metadata', 'non-file part');
  const empty = await fetch(`${address}/api/sources`, { method: 'POST', body: form });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'no_files');

  const wrongContentType = await fetch(`${address}/api/sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(wrongContentType.status, 415);
  assert.equal((await wrongContentType.json()).error.code, 'multipart_required');
  assert.equal((await fetch(`${address}/api/sources/${randomUUID()}`, { method: 'DELETE' })).status, 404);
});

test('a missing filename fails just that file and leaves both adjacent files usable', async (t) => {
  const address = await startServer(t);
  const boundary = 'upload-item-isolation';
  const named = (name: string) => Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="files"; filename="' + name +
    '"\r\nContent-Type: application/pdf\r\n\r\n');
  const unnamed = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="files"\r\nContent-Type: application/octet-stream\r\n\r\n');
  const lineEnd = Buffer.from('\r\n');
  const file = makePdf(['A readable file']);
  const response = await fetch(address + '/api/sources', { method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body: new Uint8Array(Buffer.concat([named('one.pdf'), file, lineEnd, unnamed, Buffer.from('no filename'), lineEnd,
      named('two.pdf'), file, lineEnd, Buffer.from('--' + boundary + '--\r\n')])) });
  assert.equal(response.status, 202);
  const { items } = await response.json() as { items: SourceReply[] };
  assert.equal(items.length, 3);
  const results = await Promise.all(items.map(({ id }) => readCompletedSource(address, id)));
  assert.deepEqual(results.map(({ status, error }) => [status, error?.code]), [['ready', undefined], ['failed', 'missing_filename'], ['ready', undefined]]);
});

test('UTF-16 DOCX content types, relationships and body are normalized for text extraction', async (t) => {
  const address = await startServer(t);
  const sample = await makeDocx([['UTF-16 中文正文']]);
  const fixtures: Array<[string, Buffer]> = [];
  for (const endian of ['le', 'be']) {
    const archive = await JSZip.loadAsync(sample);
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
      const xml = (await archive.file(name)!.async('string')).replace(/UTF-8/gi, 'UTF-16');
      const bytes = Buffer.from('\uFEFF' + xml, 'utf16le');
      archive.file(name, endian === 'le' ? bytes : bytes.swap16());
    }
    const bytes = await archive.generateAsync({ type: 'nodebuffer' });
    assert.deepEqual(await parseSource(bytes, 'docx', defaultDocxUnpackedBytes), [{ number: 1, text: 'UTF-16 中文正文' }]);
    fixtures.push(['encoding-' + endian + '.docx', bytes]);
  }
  const items = await uploadFiles(address, fixtures);
  const outcomes = await Promise.all(items.map(({ id }) => readCompletedSource(address, id)));
  assert.deepEqual(outcomes.map(({ status }) => status), ['ready', 'ready']);
});

test('staging capacity is applied to the batch and released for the next request', async (t) => {
  const pdf = makePdf(['A readable document']);
  const app = createWorkbenchServer({ databasePath: ':memory:', maxSourceStagingBytes: pdf.length });
  t.after(() => app.close());
  const address = await app.listen({ host: loopbackHost, port: 0 });
  const [first, second] = await uploadFiles(address, [['one.pdf', pdf], ['two.pdf', pdf]]);
  assert.equal((await readCompletedSource(address, first.id)).status, 'ready');
  assert.equal((await readCompletedSource(address, second.id)).error?.code, 'staging_capacity');
  const [retry] = await uploadFiles(address, [['two.pdf', pdf]]);
  assert.equal((await readCompletedSource(address, retry.id)).status, 'ready');
});

test('startup reclaims interrupted staging from a dead process and preserves a live owner', async (t) => {
  const dead = await mkdtemp(join(tmpdir(), 'workbench-sources-pid-2147483647-'));
  const live = await mkdtemp(join(tmpdir(), 'workbench-sources-pid-' + process.pid + '-'));
  const file = randomUUID();
  try {
    await writeFile(join(dead, file), 'Abandoned synthetic upload');
    await writeFile(join(live, file), 'Active synthetic upload');
    await startServer(t);
    await assert.rejects(access(dead), { code: 'ENOENT' });
    assert.equal(await readFile(join(live, file), 'utf8'), 'Active synthetic upload');
  } finally {
    for (const directory of [dead, live]) {
      await rm(join(directory, file), { force: true });
      await rmdir(directory).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
});

test('parsing preserves page and paragraph numbers across empty sections', async () => {
  const pdf = makePdf(['First page', '', 'Third page']);
  const docx = await makeDocx([['第一段'], [], ['Third paragraph', 'with a line break']]);
  assert.deepEqual(await parseSource(pdf, 'pdf', defaultDocxUnpackedBytes), [
    { number: 1, text: 'First page' },
    { number: 3, text: 'Third page' },
  ]);
  assert.deepEqual(await parseSource(docx, 'docx', defaultDocxUnpackedBytes), [
    { number: 1, text: '第一段' },
    { number: 3, text: 'Third paragraph\nwith a line break' },
  ]);
});

test('the local library keeps only successful opted-in unique documents across deletion and restart', async () => {
  const directory = await mkdtempDisposable(join(tmpdir(), 'workbench-library-'));
  const databasePath = join(directory.path, 'workspace.sqlite');
  let app = createWorkbenchServer({ databasePath });
  async function counts(address: string) {
    const response = await fetch(address + '/api/knowledge-bases');
    assert.equal(response.status, 200);
    return (await response.json()).items.map(({ id, documentCount }: { id: string; documentCount: number }) => [id, documentCount]);
  }
  try {
    let address = await app.listen({ host: loopbackHost, port: 0 });
    assert.deepEqual(await counts(address), [['my-materials', 0], ['sample-writing', 1]]);
    const [off] = await uploadFiles(address, [['off.pdf', makePdf(['Not in the library'])]]);
    await readCompletedSource(address, off.id);
    assert.deepEqual(await counts(address), [['my-materials', 0], ['sample-writing', 1]]);
    const pdf = makePdf(['Saved example']);
    const batch = await uploadFiles(address, [['first.pdf', pdf], ['duplicate.pdf', pdf], ['broken.docx', Buffer.from('invalid')]], true);
    await Promise.all(batch.map(({ id }) => readCompletedSource(address, id)));
    assert.deepEqual(await counts(address), [['my-materials', 1], ['sample-writing', 1]]);
    assert.equal((await fetch(address + '/api/sources/' + batch[0].id, { method: 'DELETE' })).status, 204);
    await app.close();
    app = createWorkbenchServer({ databasePath });
    address = await app.listen({ host: loopbackHost, port: 0 });
    assert.deepEqual(await counts(address), [['my-materials', 1], ['sample-writing', 1]]);
  } finally {
    await app.close();
    await directory.remove();
  }
});

test('analysis builds a versioned, deduplicated source snapshot and validates citations', async (t) => {
  let outOfScope = false;
  const app = createWorkbenchServer({ databasePath: ':memory:', maxContextCharacters: 40,
    model: { configured: true, async complete(_instruction, input) {
      const { fragments } = input as { fragments: Array<{ id: string; text: string }> };
      return { content: fragments.map(({ text }) => text).join('|'), keyPoints: ['Summary point'],
        citations: outOfScope ? ['outside'] : fragments.map(({ id }) => id) };
    } },
  });
  t.after(() => app.close());
  const base = await app.listen({ host: loopbackHost, port: 0 });
  async function analyze(sourceIds: string[], libraryIds: string[]) {
    return await fetch(base + '/api/analysis', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceIds, libraryIds, version: 'revision-1' }) });
  }
  const [pdf, docx, unusable] = await uploadFiles(base, [
    ['source.pdf', makePdf(['', 'Unique PDF fact'])],
    ['source.docx', await makeDocx([[], ['Unique DOCX fact']])],
    ['broken.pdf', Buffer.from('broken')],
  ], true);
  await Promise.all([pdf, docx, unusable].map(({ id }) => readCompletedSource(base, id)));
  const response = await analyze([pdf.id, docx.id, unusable.id, randomUUID()], ['my-materials']);
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.ok(summary.id && summary.createdAt);
  assert.equal(summary.version, 'revision-1');
  assert.equal(summary.partial, false);
  assert.equal(summary.content, 'Unique PDF fact|Unique DOCX fact');
  assert.deepEqual(summary.citations.map(({ format, number, library }: { format: string; number: number; library: string }) =>
    [format, number, library]), [['pdf', 2, '我的素材库'], ['docx', 2, '我的素材库']]);
  const librarySummary = await (await analyze([], ['sample-writing'])).json();
  assert.ok(librarySummary.partial);
  assert.equal(librarySummary.citations[0].library, '写作素材示例');
  await fetch(base + '/api/sources/' + pdf.id, { method: 'DELETE' });
  assert.equal((await analyze([pdf.id], [])).status, 400);
  outOfScope = true;
  const invalid = await analyze([], ['sample-writing']);
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).error.code, 'invalid_citations');
});
