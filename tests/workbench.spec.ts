import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

test('the workbench shows three empty columns and a same-origin service status', async ({ page }) => {
  await page.route('**/api/jobs', (route) => route.fulfill({ json: { items: [] } }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '写作助手' })).toBeVisible();
  const sources = page.getByRole('complementary', { name: '写作来源' });
  const writing = page.getByRole('region', { name: '分析与对话' });
  const results = page.getByRole('complementary', { name: '生成结果' });
  await expect(sources.getByText('暂无写作素材')).toBeVisible();
  await expect(sources.getByText('暂无已选知识库')).toBeVisible();
  await expect(writing.getByText('暂无分析和对话')).toBeVisible();
  await expect(results.getByText('暂无生成记录')).toBeVisible();

  const [left, middle, right] = await Promise.all([
    sources.boundingBox(), writing.boundingBox(), results.boundingBox(),
  ]);
  expect(left!.x + left!.width).toBeLessThanOrEqual(middle!.x);
  expect(middle!.x + middle!.width).toBeLessThanOrEqual(right!.x);

  const health = await page.request.get('/api/health');
  expect(health.ok()).toBe(true);
  await expect(page.getByRole('status')).toContainText('服务已连接');
  await expect(page.getByRole('status')).toContainText('模型已配置');
});

test('keyboard retry retains focus after a repeated connection failure', async ({ page }) => {
  const healthRoute = '**/api/health';
  await page.route(healthRoute, (route) => route.abort());
  await page.goto('/');

  const status = page.getByRole('status');
  const retry = page.getByRole('button', { name: '重新连接' });
  await expect(status).toContainText('服务连接失败');
  await page.keyboard.press('Tab');
  await expect(retry).toBeFocused();

  let finishRequest = () => {};
  const pendingResponse = new Promise<void>((resolve) => { finishRequest = resolve; });
  let requestCount = 0;
  await page.unroute(healthRoute);
  await page.route(healthRoute, async (route) => {
    requestCount += 1;
    await pendingResponse;
    await route.abort();
  });

  try {
    await page.keyboard.press('Enter');
    await expect(status).toContainText('正在检查服务');
    await expect(retry).toBeDisabled();
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
  } finally {
    finishRequest();
  }

  await expect(status).toContainText('服务连接失败');
  await expect(retry).toBeEnabled();
  await expect(retry).toBeFocused();
  expect(requestCount).toBe(1);

  await page.unroute(healthRoute);
  await page.keyboard.press('Enter');
  await expect(status).toContainText('服务已连接');
  await expect(retry).toHaveCount(0);
});

test('the development server denies direct access to back-end data files', async ({ request }) => {
  const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
  await mkdir(dataDirectory, { recursive: true });
  const fixtureDirectory = await mkdtemp(join(dataDirectory, 'access-test-'));
  const fixture = join(fixtureDirectory, 'server-only.txt');

  try {
    await writeFile(fixture, 'Synthetic test fixture');
    // Vite file URLs omit the leading slash before a Windows drive letter.
    const filePath = pathToFileURL(fixture).pathname.replace(/^\/(?=[A-Za-z]:\/)/, '');
    const response = await request.get(`/@fs/${filePath}`);
    expect(response.status()).toBe(403);
  } finally {
    await rm(fixture, { force: true });
    await rmdir(fixtureDirectory);
  }
});
