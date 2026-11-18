import { expect, test } from '@playwright/test';

test('selecting, dropping and pasting files shares source state, retry and removal', async ({ page }) => {
  let next = 0;
  await page.route('**/api/sources', async (route) => {
    const sent = route.request().postData() ?? '';
    const items = [...sent.matchAll(/filename="([^"]+)"/g)].map(([, name]) => {
      next += 1;
      const fail = name === 'retry.pdf' && !sent.includes('selected.pdf') && next === 2;
      return { id: String(next), name, status: fail ? 'failed' : 'ready', error: fail ? { message: '无法解析' } : null };
    });
    await route.fulfill({ status: 202, json: { items } });
  });
  await page.route('**/api/sources/*', (route) => route.fulfill({ status: 204 }));
  await page.goto('/');
  const picker = page.locator('input[type=file]');
  await picker.setInputFiles({ name: 'selected.pdf', mimeType: 'application/pdf', buffer: Buffer.from('sample') });
  await expect(page.getByText('已选 1 个来源')).toBeVisible();
  await picker.setInputFiles({ name: 'retry.pdf', mimeType: 'application/pdf', buffer: Buffer.from('sample') });
  await expect(page.getByText('无法解析')).toBeVisible();
  await expect(page.getByText('已选 1 个来源')).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('已选 2 个来源')).toBeVisible();

  const upload = page.getByRole('button', { name: /导入 PDF/ });
  for (const [eventName, name] of [['drop', 'drop.docx'], ['paste', 'paste.pdf']]) {
    await upload.evaluate((element, [kind, fileName]) => {
      const data = new DataTransfer();
      data.items.add(new File(['sample'], fileName));
      element.dispatchEvent(kind === 'drop'
        ? new DragEvent(kind, { bubbles: true, dataTransfer: data })
        : new ClipboardEvent(kind, { bubbles: true, clipboardData: data }));
    }, [eventName, name]);
    await expect(page.getByRole('checkbox', { name })).toBeEnabled();
  }
  await expect(page.getByText('已选 4 个来源')).toBeVisible();
  await page.getByRole('checkbox', { name: 'selected.pdf' }).uncheck();
  await page.getByRole('button', { name: '移除 drop.docx' }).click();
  await expect(page.getByText('已选 2 个来源')).toBeVisible();
});
