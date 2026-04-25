import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionClosePayload } from '@auradent/shared';

export type SessionCloseArtifacts = {
  findings: SessionClosePayload['structuredFindings'];
  metrics: Array<{
    name: string;
    value: number;
    unit: string;
    ts: string;
  }>;
  traceEvents: Array<{
    step: string;
    detail: string;
    confidence?: number;
    ts: string;
  }>;
  transcriptEntries: Array<{
    utteranceId: string;
    text: string;
    redactedText?: string;
  }>;
};

export function buildSessionClosePayload(args: {
  sessionId: string;
  patientId: string;
  closedAt?: string;
  artifacts: SessionCloseArtifacts;
}): SessionClosePayload {
  const { artifacts, patientId, sessionId } = args;

  return {
    sessionId,
    patientId,
    closedAt: args.closedAt ?? new Date().toISOString(),
    transcript: {
      finalText: artifacts.transcriptEntries.map((entry) => entry.redactedText ?? entry.text).join(' '),
    },
    structuredFindings: artifacts.findings,
    artifacts: {
      trace: artifacts.traceEvents,
      metrics: artifacts.metrics,
    },
  };
}

export async function writeSessionClosePayloadToDisk(args: {
  payload: SessionClosePayload;
  directory?: string;
}) {
  const directory = args.directory ?? path.resolve(process.cwd(), 'tmp/session-close');

  await mkdir(directory, { recursive: true });

  const contents = `${JSON.stringify(args.payload, null, 2)}\n`;
  const latestPath = path.join(directory, 'latest-session-close.json');
  const sessionPath = path.join(directory, `${args.payload.sessionId}.json`);

  await Promise.all([
    writeFile(latestPath, contents, 'utf8'),
    writeFile(sessionPath, contents, 'utf8'),
  ]);

  return {
    latestPath,
    sessionPath,
  };
}
