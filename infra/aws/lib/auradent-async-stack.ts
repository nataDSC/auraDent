import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export class AuraDentAsyncStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const deadLetterQueue = new sqs.Queue(this, 'SessionCloseDlq', {
      retentionPeriod: Duration.days(14),
    });

    const sessionCloseQueue = new sqs.Queue(this, 'SessionCloseQueue', {
      visibilityTimeout: Duration.seconds(60),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: deadLetterQueue,
      },
    });

    const worker = new lambda.Function(this, 'SessionWrapWorker', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log(JSON.stringify({ message: 'Replace inline handler with apps/worker build artifact', records: event.Records?.length ?? 0 }));
        };
      `),
    });

    worker.addEventSource(new SqsEventSource(sessionCloseQueue, { batchSize: 5 }));
  }
}
