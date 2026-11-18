import { expect, test } from '@playwright/test';

test('library drafts can be filtered and cancelled and enabled choices control the count', async ({ page }) => {
  await page.route('**/api/knowledge-bases', (route) => route.fulfill({ json: { items: [
    { id: 'my-materials', name: '我的素材库', description: '本地素材', documentCount: 0 },
    { id: 'sample-writing', name: '写作素材示例', description: '示例库', documentCount: 1 },
  ] } }));
  await page.goto('/');
  await expect(page.getByRole('checkbox', { name: '纳入知识库' })).not.toBeChecked();
  const open = page.getByRole('button', { name: '选择知识库' });
  await open.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('搜索知识库').fill('示例');
  await dialog.getByLabel('全选搜索结果').check();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(page.getByText('暂无已选知识库')).toBeVisible();
  await open.click();
  await dialog.getByLabel('搜索知识库').fill('示例');
  await dialog.getByLabel('全选搜索结果').check();
  await dialog.getByRole('button', { name: '确定' }).click();
  await expect(page.getByText('已选 1 个来源')).toBeVisible();
  await page.getByLabel('启用全部已选库').uncheck();
  await open.click();
  await dialog.getByLabel('我的素材库', { exact: true }).check();
  await dialog.getByRole('button', { name: '确定' }).click();
  await expect(page.getByText('没有可引用内容')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '写作素材示例', exact: true })).not.toBeChecked();
  await expect(page.getByText('已选 0 个来源')).toBeVisible();
});

test('keyboard opening focuses the library search and Escape restores focus without applying drafts', async ({ page }) => {
  await page.goto('/');
  const open = page.getByRole('button', { name: '选择知识库' });
  await open.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: '选择知识库' });
  await expect(dialog.getByRole('textbox', { name: '搜索知识库' })).toBeFocused();
  await dialog.getByRole('checkbox', { name: '写作素材示例' }).check();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(page.getByText('暂无已选知识库')).toBeVisible();
});
