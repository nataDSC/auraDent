import type { SQSEvent, SQSHandler } from 'aws-lambda';
import type { SessionClosePayload } from '@auradent/shared';
import { processSessionClosePayload, withSessionPersistence } from './process-session-close';

export const handler: SQSHandler = async (event: SQSEvent) => {
  await withSessionPersistence(async (persistence) => {
    for (const record of event.Records) {
      const payload = JSON.parse(record.body) as SessionClosePayload;
      const summary = await processSessionClosePayload(payload, persistence);

      console.log(
        JSON.stringify({
          level: 'info',
          message: 'Processed session close payload into enriched async record',
          sessionId: summary.sessionId,
          findings: summary.findings,
          persistence: summary.persistence,
          postOpFile: summary.postOpFile,
          insuranceStatus: summary.insuranceStatus,
          persisted: true,
        }),
      );
    }
  });
};
