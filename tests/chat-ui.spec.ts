import { expect, test } from '@playwright/test';

test('composition and empty questions do not send, and failed messages can be retried', async ({ page }) => {
  let sent = 0;
  let retrySources: string[] = [];
  await page.route('**/api/chat', async (route) => {
    sent += 1;
    if (sent === 1) await route.fulfill({ status: 502, json: { error: { message: '模型暂不可用' } } });
    else {
      retrySources = route.request().postDataJSON().libraryIds;
      await route.fulfill({ json: { content: '回复成功', citations: [], insufficient: false, partial: false } });
    }
  });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '提问' });
  const send = page.getByRole('button', { name: '发送' });
  await input.fill('   ');
  await expect(send).toBeDisabled();
  await input.fill('一个问题');
  await input.evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await input.press('Enter');
  await expect(page.getByLabel('对话记录')).toHaveCount(0);
  await input.evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await input.press('Enter');
  await expect(page.getByText('模型暂不可用')).toBeVisible();
  await page.getByRole('button', { name: '选择知识库' }).click();
  await page.getByRole('dialog').getByLabel('写作素材示例').check();
  await page.getByRole('button', { name: '确定' }).click();
  await page.getByRole('button', { name: '重试问答' }).click();
  await expect(page.getByText('回复成功')).toBeVisible();
  expect(retrySources).toEqual(['sample-writing']);
  await page.getByRole('checkbox', { name: '写作素材示例', exact: true }).uncheck();
  await expect(page.getByText('回复成功')).toBeVisible();
  await expect(page.getByText('暂无分析和对话', { exact: true })).toHaveCount(0);
});

test('a reply without selected sources replaces the empty conversation state', async ({ page }) => {
  await page.goto('/');
  const empty = page.getByText('暂无分析和对话', { exact: true });
  await expect(empty).toBeVisible();
  const input = page.getByRole('textbox', { name: '提问' });
  await input.fill('无来源的普通问题');
  await input.press('Enter');
  await expect(page.getByText('回答 · 无来源的普通问题', { exact: true })).toBeVisible();
  await expect(empty).toHaveCount(0);
});
