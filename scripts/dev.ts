import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { createWorkbenchServer, loopbackHost } from '../server/app.ts';

const app = createWorkbenchServer();
let vite: ViteDevServer | undefined;

try {
  const apiAddress = await app.listen({ host: loopbackHost, port: 0 });
  vite = await createServer({
    server: {
      host: loopbackHost,
      port: Number(process.env.WORKBENCH_PORT ?? 5173),
      strictPort: true,
      proxy: { '/api': apiAddress },
    },
  });
  await vite.listen();
  vite.printUrls();
} catch (error) {
  await Promise.allSettled([vite?.close(), app.close()]);
  throw error;
}

function closeServers() {
  void Promise.allSettled([vite?.close(), app.close()]);
}

process.once('SIGINT', closeServers);
process.once('SIGTERM', closeServers);
