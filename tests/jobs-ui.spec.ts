import { expect, test } from '@playwright/test';

test('PPT settings require an explicit submit and expose progress and failure after reload', async ({ page }) => {
  let submissions = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/jobs') && request.method() === 'POST') submissions += 1; });
  await page.goto('/');
  const generate = page.getByRole('button', { name: '生成演讲文稿' });
  const list = page.getByRole('list', { name: '生成记录' });
  await page.getByRole('button', { name: '通用写作', exact: true }).click();
  await page.getByRole('button', { name: '演讲文稿', exact: true }).click();
  await page.getByLabel('篇幅').selectOption('short');
  await generate.click();
  await expect(page.getByText('请选择可用来源或填写生成要求。')).toBeVisible();
  expect(submissions).toBe(0);
  await page.getByLabel('Slide 描述').fill('演讲进度验收');
  await generate.click();
  await list.getByRole('button', { name: '进度' }).first().click();
  await expect(page.getByRole('dialog', { name: '任务进度' }).getByRole('status')).toHaveText('已完成');
  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByLabel('Slide 描述').fill('测试生成失败');
  await generate.click();
  await expect(list.getByText('生成失败', { exact: true })).toBeVisible();
  await page.reload();
  await expect(list.getByText('演讲文稿示例', { exact: true }).first()).toBeVisible();
  await expect(list.getByText('生成失败', { exact: true })).toBeVisible();
});

test('two records with the same title preview their own HTML and can be downloaded', async ({ page }) => {
  await page.goto('/');
  const list = page.getByRole('list', { name: '生成记录' });
  await page.getByLabel('篇幅').selectOption('short');
  for (const label of ['独立幻灯片一 <示例>', '独立幻灯片二 & 内容']) {
    await page.getByLabel('Slide 描述').fill(label);
    const [created] = await Promise.all([page.waitForResponse((response) => response.url().endsWith('/api/jobs') && response.status() === 202),
      page.getByRole('button', { name: '生成演讲文稿' }).click()]);
    const job = await created.json();
    await expect.poll(async () => (await (await page.request.get('/api/jobs/' + job.id)).json()).status).toBe('completed');
    const complete = await (await page.request.get('/api/jobs/' + job.id)).json();
    const record = list.locator('li').filter({ has: page.locator('a[href="/api/artifacts/' + complete.artifactId + '/download"]') });
    await expect(record.getByText('演讲文稿示例')).toBeVisible();
    await record.getByRole('button', { name: '预览' }).click();
    const frame = page.frameLocator('iframe[title="产物预览"]');
    await expect(frame.getByText(label, { exact: true }).first()).toBeVisible();
    await expect(frame.locator('.slide')).toHaveCount(4);
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载 HTML' }).click();
    expect((await downloaded).suggestedFilename()).toMatch(/\.html$/);
    await page.getByRole('button', { name: '返回记录' }).click();
  }
});

test('a broken event stream recovers the terminal job and browser retry creates a new record', async ({ page }) => {
  await page.route(/\/api\/jobs\/[^/]+\/events$/, (route) => route.abort());
  await page.goto('/');
  const list = page.getByRole('list', { name: '生成记录' });
  await page.getByRole('button', { name: '通用写作', exact: true }).click();
  await page.getByLabel('写作要求').fill('断流完成样例');
  await page.getByRole('button', { name: '生成文稿' }).click();
  await expect(list.getByRole('listitem').filter({ hasText: '断流完成样例' }).getByRole('button', { name: '预览' })).toBeVisible();
  await page.getByLabel('写作要求').fill('测试生成失败 · 断流重试');
  await page.getByRole('button', { name: '生成文稿' }).click();
  const rows = list.getByRole('listitem').filter({ hasText: '测试生成失败 · 断流重试' });
  const latest = rows.first();
  await expect(rows).toHaveCount(1);
  const [retry] = await Promise.all([page.waitForResponse((response) => response.url().endsWith('/retry') && response.status() === 202),
    latest.getByRole('button', { name: '重试生成' }).click()]);
  expect((await retry.json()).id).toBeTruthy();
  await expect(rows).toHaveCount(2);
});

test('an independent preview and clipboard fallback address the same saved artifact', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.reject(new Error('Clipboard denied')) },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: '通用写作', exact: true }).click();
  await page.getByLabel('写作要求').fill('独立预览验收');
  await page.getByRole('button', { name: '生成文稿' }).click();
  await page.getByRole('list', { name: '生成记录' }).getByRole('listitem').filter({ hasText: '独立预览验收' })
    .getByRole('button', { name: '预览' }).click();
  await page.getByRole('button', { name: '复制本地链接' }).click();
  const url = await page.getByLabel('手动复制链接').inputValue();
  const [popup] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('link', { name: '在新窗口预览' }).click()]);
  await expect(popup).toHaveURL(url);
  await expect(popup.frameLocator('iframe').getByRole('heading', { name: '独立预览验收' })).toBeVisible();
  await popup.goto('/?artifact=missing');
  await expect(popup.getByRole('alert')).toHaveText('找不到可用的生成产物。');
});

test('records can be renamed and deletion requests require confirmation and report failures', async ({ page }) => {
  await page.goto('/');
  const list = page.getByRole('list', { name: '生成记录' });
  await page.getByRole('button', { name: '通用写作', exact: true }).click();
  await page.getByLabel('写作要求').fill('记录管理样例');
  await page.getByRole('button', { name: '生成文稿' }).click();
  await list.getByRole('listitem').filter({ hasText: '记录管理样例' }).getByRole('button', { name: '重命名' }).click();
  await page.getByLabel('新标题').fill('已改名验收');
  await page.getByRole('button', { name: '保存名称' }).click();
  const row = list.getByRole('listitem').filter({ hasText: '已改名验收' });
  await expect(row).toBeVisible();
  const link = await row.getByRole('link', { name: '下载 HTML' }).getAttribute('href');
  expect(link).toBeTruthy();
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog', { name: '删除记录' }).getByRole('button', { name: '取消' }).click();
  await expect(row).toBeVisible();
  const failing = /\/api\/jobs\/[^/]+$/;
  await page.route(failing, (route) => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 500, json: { error: { message: '模拟删除失败' } } }) : route.continue());
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('模拟删除失败', { exact: true })).toBeVisible();
  await expect(row).toBeVisible();
  await page.unroute(failing);
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(row).toHaveCount(0);
  expect((await page.request.get(link!)).status()).toBe(404);
});

test('writing an ordinary draft or notice and building a mind map can be previewed and downloaded', async ({ page }) => {
  await page.goto('/');
  const records = page.getByRole('list', { name: '生成记录' });
  for (const mode of ['general', 'notice']) {
    const title = mode === 'general' ? '普通方案样例' : '通知样例';
    await page.getByRole('button', { name: '通用写作', exact: true }).click();
    await page.getByLabel('文稿类型').selectOption(mode);
    await page.getByLabel('写作要求').fill(title);
    await page.getByRole('button', { name: '生成文稿' }).click();
    await records.getByRole('listitem').filter({ hasText: title }).getByRole('button', { name: '预览' }).click();
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('heading', { name: title })).toBeVisible();
    if (mode === 'notice') {
      await expect(frame.getByText('【待填写日期】', { exact: true })).toBeVisible();
      await expect(frame.getByText('【待填写发文单位】', { exact: true })).toBeVisible();
    }
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载 HTML' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.html$/);
    await page.getByRole('button', { name: '返回记录' }).click();
  }
  await page.getByRole('button', { name: '思维导图', exact: true }).click();
  await page.getByLabel('导图主题').fill('脑图验收');
  await page.getByRole('button', { name: '生成导图' }).click();
  await records.getByRole('listitem').filter({ hasText: '脑图验收' }).getByRole('button', { name: '预览' }).click();
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: '脑图验收' })).toBeVisible();
  await expect(frame.locator('ul li ul li')).toHaveText('分支下的子节点');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载 HTML' }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.html$/);
});
