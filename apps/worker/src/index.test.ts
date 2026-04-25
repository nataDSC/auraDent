import test from 'node:test';
import assert from 'node:assert/strict';
import type { SQSEvent } from 'aws-lambda';
import { processSqsBatch } from './index';

test('processSqsBatch returns only failed message ids for retry/DLQ behavior', async () => {
  const event: SQSEvent = {
    Records: [
      {
        messageId: 'msg-ok',
        receiptHandle: 'receipt-ok',
        body: '{"sessionId":"ok"}',
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '0',
          SenderId: 'test',
          ApproximateFirstReceiveTimestamp: '0',
        },
        messageAttributes: {},
        md5OfBody: 'ok',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-west-2:123456789012:test',
        awsRegion: 'us-west-2',
      },
      {
        messageId: 'msg-fail',
        receiptHandle: 'receipt-fail',
        body: '{"sessionId":"fail"}',
        attributes: {
          ApproximateReceiveCount: '2',
          SentTimestamp: '0',
          SenderId: 'test',
          ApproximateFirstReceiveTimestamp: '0',
        },
        messageAttributes: {},
        md5OfBody: 'fail',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-west-2:123456789012:test',
        awsRegion: 'us-west-2',
      },
    ],
  };

  const processed: string[] = [];

  const response = await processSqsBatch({
    event,
    processRecord: async (record) => {
      processed.push(record.messageId);

      if (record.messageId === 'msg-fail') {
        throw new Error('boom');
      }
    },
  });

  assert.deepEqual(processed, ['msg-ok', 'msg-fail']);
  assert.deepEqual(response, {
    batchItemFailures: [{ itemIdentifier: 'msg-fail' }],
  });
});
