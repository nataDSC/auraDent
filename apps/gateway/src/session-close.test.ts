import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildSessionClosePayload, writeSessionClosePayloadToDisk } from './session-close';

test('buildSessionClosePayload prefers redacted transcript text and preserves findings', () => {
  const payload = buildSessionClosePayload({
    sessionId: 'session-1',
    patientId: 'patient-1',
    closedAt: '2026-04-25T12:00:00.000Z',
    artifacts: {
      transcriptEntries: [
        {
          utteranceId: 'utt-1',
          text: 'Patient James Brown.',
          redactedText: 'Patient [PATIENT_NAME].',
        },
        {
          utteranceId: 'utt-2',
          text: 'Has four millimeter pockets on tooth 14.',
        },
      ],
      findings: [
        {
          toothNumber: 14,
          probingDepthMm: 4,
          confidence: 0.95,
          sourceUtteranceId: 'utt-2',
        },
      ],
      traceEvents: [{ step: 'agent.completed', detail: 'ok', ts: '2026-04-25T12:00:01.000Z' }],
      metrics: [{ name: 'ttft', value: 120, unit: 'ms', ts: '2026-04-25T12:00:00.100Z' }],
    },
  });

  assert.equal(payload.transcript.finalText, 'Patient [PATIENT_NAME]. Has four millimeter pockets on tooth 14.');
  assert.equal(payload.structuredFindings[0]?.toothNumber, 14);
  assert.equal(payload.artifacts.trace.length, 1);
});

test('writeSessionClosePayloadToDisk writes latest and session-specific payload files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'auradent-session-close-'));
  const payload = buildSessionClosePayload({
    sessionId: 'session-2',
    patientId: 'patient-2',
    artifacts: {
      transcriptEntries: [{ utteranceId: 'utt-1', text: 'on tooth 14' }],
      findings: [],
      traceEvents: [],
      metrics: [],
    },
  });

  const paths = await writeSessionClosePayloadToDisk({
    payload,
    directory,
  });

  const latest = JSON.parse(await readFile(paths.latestPath, 'utf8')) as { sessionId: string };
  const sessionSpecific = JSON.parse(await readFile(paths.sessionPath, 'utf8')) as { sessionId: string };

  assert.equal(latest.sessionId, 'session-2');
  assert.equal(sessionSpecific.sessionId, 'session-2');
});
