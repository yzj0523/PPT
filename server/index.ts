import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createWorkbenchServer, loopbackHost } from './app.ts';

const staticRoot = fileURLToPath(new URL('../dist/web/', import.meta.url));
try {
  await access(new URL('../dist/web/index.html', import.meta.url));
} catch {
  throw new Error('无法读取工作台页面，请先运行 npm run build。');
}

const app = createWorkbenchServer({ staticRoot });

try {
  const address = await app.listen({
    host: loopbackHost,
    port: Number(process.env.WORKBENCH_PORT ?? 4173),
  });
  console.log(`写作助手 ${address}`);
} catch (error) {
  await app.close();
  throw error;
}

process.once('SIGINT', () => void app.close());
process.once('SIGTERM', () => void app.close());
