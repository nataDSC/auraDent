import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Construct } from 'constructs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

    const worker = new NodejsFunction(this, 'SessionWrapWorker', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.resolve(__dirname, '../../../apps/worker/src/index.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 512,
      depsLockFilePath: path.resolve(__dirname, '../../../package-lock.json'),
      bundling: {
        target: 'node22',
        format: OutputFormat.ESM,
        sourceMap: true,
      },
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    worker.addEventSource(new SqsEventSource(sessionCloseQueue, { batchSize: 5 }));

    sessionCloseQueue.grantConsumeMessages(worker);

    new CfnOutput(this, 'SessionCloseQueueUrl', {
      value: sessionCloseQueue.queueUrl,
    });

    new CfnOutput(this, 'SessionCloseQueueArn', {
      value: sessionCloseQueue.queueArn,
    });
  }
}
