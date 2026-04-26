#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { AuraDentAsyncStack } from '../lib/auradent-async-stack';

const app = new App();

new AuraDentAsyncStack(app, 'AuraDentAsyncStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
