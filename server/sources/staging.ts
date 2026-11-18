import { mkdtemp, open, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MultipartFile } from '@fastify/multipart';
import { maxSourceFileBytes } from './parse.ts';

export const defaultStagingBytes = 128 * 1024 * 1024;
const directoryPrefix = 'workbench-sources-pid-';
const stagedName = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export function newStagingDirectory() {
  return mkdtemp(join(tmpdir(), directoryPrefix + process.pid + '-'));
}

export async function reclaimInterruptedUploads() {
  const root = tmpdir();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const match = entry.name.match(/^workbench-sources-pid-(\d{1,10})-[a-zA-Z0-9]{6}$/);
    if (!entry.isDirectory() || !match) continue;
    const pid = Number(match[1]);
    if (pid < 1 || pid > 2147483647 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
    }

    const directory = join(root, entry.name);
    try {
      const files = await readdir(directory, { withFileTypes: true });
      if (!files.every((file) => file.isFile() && stagedName.test(file.name))) continue;
      for (const file of files) await rm(join(directory, file.name), { force: true });
      await rmdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export type StagedFile = { take: () => Promise<Buffer>; remove: () => Promise<void> };

export function createStagingBudget(limit: number) {
  let used = 0;

  return async function stage(part: MultipartFile, path: string): Promise<
    { file: StagedFile } | { error: 'file_too_large' | 'staging_capacity' }
  > {
    let reserved = 0;
    let reading: Promise<Buffer> | undefined;
    let clearing: Promise<void> | undefined;
    const handle = await open(path, 'wx');

    function remove() {
      clearing ??= (async () => {
        await reading?.catch(() => {});
        await rm(path, { force: true });
        used -= reserved;
        reserved = 0;
      })().catch((error) => { clearing = undefined; throw error; });
      return clearing;
    }

    try {
      let rejected: 'file_too_large' | 'staging_capacity' | undefined;
      try {
        for await (const chunk of part.file as AsyncIterable<Buffer>) {
          // Continue consuming a rejected multipart item so subsequent items can still be accepted.
          if (rejected) continue;
          if (reserved + chunk.length > maxSourceFileBytes) rejected = 'file_too_large';
          else if (used + chunk.length > limit) rejected = 'staging_capacity';
          else {
            used += chunk.length;
            reserved += chunk.length;
            await handle.writeFile(chunk);
          }
        }
      } finally {
        await handle.close();
      }
      const reason = part.file.truncated ? 'file_too_large' : rejected;
      if (reason) {
        await remove();
        return { error: reason };
      }
      return { file: { remove, async take() {
        reading = readFile(path);
        try { return await reading; }
        finally {
          try { await remove(); }
          finally { reading = undefined; }
        }
      } } };
    } catch (error) {
      await remove();
      throw error;
    }
  };
}
