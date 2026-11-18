import { expect, test } from '@playwright/test';

test('automatic analysis follows source changes, clears stale results and accepts custom requirements', async ({ page }) => {
  await page.route('**/api/analysis', async (route) => {
    const request = route.request().postDataJSON();
    await route.fulfill({ json: { id: 'summary', version: request.version, content: request.requirements || '示例摘要',
      keyPoints: ['关键事实'], citations: [], partial: false, createdAt: new Date().toISOString() } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '选择知识库' }).click();
  await page.getByRole('dialog').getByLabel('写作素材示例').check();
  await page.getByRole('button', { name: '确定' }).click();
  await expect(page.getByText('示例摘要', { exact: true })).toBeVisible();
  await page.getByLabel('摘要要求').fill('定制摘要');
  await page.getByRole('button', { name: '重新分析' }).click();
  await expect(page.getByText('定制摘要', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '写作素材示例', exact: true }).uncheck();
  await expect(page.getByText('定制摘要', { exact: true })).toHaveCount(0);
});

test('a saved summary remains the same after changing selection and reloading', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '选择知识库' }).click();
  await page.getByRole('dialog').getByLabel('写作素材示例').check();
  await page.getByRole('button', { name: '确定' }).click();
  const save = page.getByRole('button', { name: '保存为记录' });
  await save.click();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '写作素材示例', exact: true }).uncheck();
  await page.reload();
  const record = page.getByRole('list', { name: '生成记录' }).getByRole('listitem').filter({ hasText: '文档摘要 ·' });
  await record.getByRole('button', { name: '预览' }).click();
  await expect(page.frameLocator('iframe').getByText(/每周六举办一次开放阅读活动/)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载 HTML' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.html$/);
});

test('a late analysis result from the previous source selection cannot replace the current summary', async ({ page }) => {
  await page.route('**/api/knowledge-bases', (route) => route.fulfill({ json: { items: [
    { id: 'first', name: '来源甲', documentCount: 1 }, { id: 'second', name: '来源乙', documentCount: 1 },
  ] } }));
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/analysis', async (route) => {
    const request = route.request().postDataJSON();
    const old = request.libraryIds.includes('first');
    if (old) await held;
    await route.fulfill({ json: { id: old ? 'old' : 'new', version: request.version, content: old ? '较早分析' : '当前分析',
      keyPoints: ['关键点'], citations: [], createdAt: new Date().toISOString() } }).catch(() => {});
  });
  await page.goto('/');
  const open = page.getByRole('button', { name: '选择知识库' });
  const dialog = page.getByRole('dialog');
  try {
    await open.click();
    await dialog.getByRole('checkbox', { name: '来源甲' }).check();
    await Promise.all([page.waitForRequest('**/api/analysis'), dialog.getByRole('button', { name: '确定' }).click()]);
    await open.click();
    await dialog.getByRole('checkbox', { name: '来源甲' }).uncheck();
    await dialog.getByRole('checkbox', { name: '来源乙' }).check();
    await dialog.getByRole('button', { name: '确定' }).click();
    await expect(page.getByText('当前分析', { exact: true })).toBeVisible();
  } finally { release(); }
  await expect(page.getByText('较早分析', { exact: true })).toHaveCount(0);
});
