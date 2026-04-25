import { readFile } from 'node:fs/promises';
import process from 'node:process';
import type { SessionClosePayload } from '@auradent/shared';
import { loadWorkerLocalEnv } from './load-local-env';
import { processSessionClosePayload, withSessionPersistence } from './process-session-close';

loadWorkerLocalEnv();

async function main() {
  const payload = await readPayload();
  const summary = await withSessionPersistence((persistence) =>
    processSessionClosePayload(payload, persistence, {
      runtime: 'local',
    }),
  );

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Processed local session close payload',
      ...summary,
      persisted: true,
    }),
  );
}

async function readPayload(): Promise<SessionClosePayload> {
  const filePath = process.argv[2];
  if (filePath) {
    const contents = await readFile(filePath, 'utf8');
    return JSON.parse(contents) as SessionClosePayload;
  }

  const stdin = await readStdin();
  if (!stdin.trim()) {
    throw new Error('Expected a payload file path or JSON payload on stdin.');
  }

  return JSON.parse(stdin) as SessionClosePayload;
}

async function readStdin() {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

void main().catch((error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: error instanceof Error ? error.message : 'Local worker runner failed.',
    }),
  );
  process.exitCode = 1;
});
