import type { SQSBatchResponse, SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda';
import type { SessionClosePayload } from '@auradent/shared';
import { processSessionClosePayload, withSessionPersistence } from './process-session-close';

export const handler: SQSHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  return withSessionPersistence(async (persistence) =>
    processSqsBatch({
      event,
      processRecord: async (record) => {
        const payload = JSON.parse(record.body) as SessionClosePayload;
        const summary = await processSessionClosePayload(payload, persistence);

        console.log(
          JSON.stringify({
            level: 'info',
            message: 'Processed session close payload into enriched async record',
            messageId: record.messageId,
            sessionId: summary.sessionId,
            findings: summary.findings,
            persistence: summary.persistence,
            postOpFile: summary.postOpFile,
            insuranceStatus: summary.insuranceStatus,
            persisted: true,
            approximateReceiveCount:
              record.attributes.ApproximateReceiveCount ?? record.attributes?.ApproximateReceiveCount,
          }),
        );
      },
    }),
  );
};

export async function processSqsBatch(args: {
  event: SQSEvent;
  processRecord: (record: SQSRecord) => Promise<void>;
}): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of args.event.Records) {
    try {
      await args.processRecord(record);
    } catch (error) {
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });

      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Failed to process session close SQS record',
          messageId: record.messageId,
          approximateReceiveCount:
            record.attributes.ApproximateReceiveCount ?? record.attributes?.ApproximateReceiveCount,
          error: error instanceof Error ? error.message : 'Unknown worker processing error',
        }),
      );
    }
  }

  return {
    batchItemFailures,
  };
}
