import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createWorkbenchServer, loopbackHost } from '../server/app.ts';

test('the production start command serves the built workbench and health API together', async ({ page }) => {
  const [documentResponse, stylesheet] = await Promise.all([
    page.goto('/'),
    page.waitForResponse((response) => response.request().resourceType() === 'stylesheet'),
  ]);
  expect(documentResponse?.status()).toBe(200);
  expect(stylesheet.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '写作助手' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('服务已连接');

  const health = await page.request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'ok' });
});

test('six concurrent jobs keep ordinary browser requests available and all progress up to date', async ({ page }) => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const app = createWorkbenchServer({
    staticRoot: fileURLToPath(new URL('../dist/web/', import.meta.url)), databasePath: ':memory:',
    model: { configured: true, async complete() {
      await pending;
      return { title: '并发文稿', sections: [{ heading: '正文', paragraphs: ['文稿内容'] }] };
    } },
  });
  try {
    const base = await app.listen({ host: loopbackHost, port: 0 });
    for (let index = 0; index < 6; index += 1) {
      const result = await page.request.post(base + '/api/jobs', { data: { skill: 'writing', description: '并发任务 ' + index } });
      expect(result.status()).toBe(202);
    }

    const streamRequests = new Set<string>();
    page.on('request', (request) => { if (request.url().endsWith('/events')) streamRequests.add(request.url()); });
    await Promise.all([page.waitForResponse((response) => response.url().endsWith('/events') && response.ok()), page.goto(base)]);
    const records = page.getByRole('list', { name: '生成记录' });
    await expect(records.getByText('正在生成内容', { exact: true })).toHaveCount(6);
    const health = await page.evaluate(async () => {
      const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
      return response.status;
    });
    expect(health).toBe(200);
    expect(streamRequests.size).toBe(1);

    release();
    await expect(records.getByText('已完成', { exact: true })).toHaveCount(6);
  } finally {
    release();
    await page.close();
    await app.close();
  }
});
