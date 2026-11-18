import { expect, test } from '@playwright/test';
import { makeDocx, makePdf } from './documents.ts';

test('documents uploaded through the workbench appear in versioned analysis and the local library', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('checkbox', { name: '纳入知识库' }).check();
  await page.locator('input[type=file]').setInputFiles([
    { name: '资料一.pdf', mimeType: 'application/pdf', buffer: makePdf(['Verified PDF fact 208']) },
    { name: '资料二.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: await makeDocx([['Verified DOCX fact 36']]) },
  ]);
  const analysis = page.getByRole('region', { name: '文档分析' });
  await expect(analysis.getByText(/Verified PDF fact 208/)).toBeVisible();
  await expect(analysis.getByText(/Verified DOCX fact 36/)).toBeVisible();
  await expect(analysis.getByText('资料一.pdf · 第 1 页')).toBeVisible();
  await expect(analysis.getByText('资料二.docx · 第 1 段')).toBeVisible();

  await page.getByRole('checkbox', { name: '资料一.pdf', exact: true }).uncheck();
  await expect(analysis.getByText(/Verified DOCX fact 36/)).toBeVisible();
  await expect(analysis.getByText(/Verified PDF fact 208/)).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: '选择知识库' }).click();
  await page.getByRole('dialog').getByRole('checkbox', { name: '我的素材库' }).check();
  await page.getByRole('button', { name: '确定' }).click();
  await expect(analysis.getByText(/Verified PDF fact 208/)).toBeVisible();
  await expect(analysis.getByText('我的素材库 · 资料一.pdf · 第 1 页')).toBeVisible();
});
