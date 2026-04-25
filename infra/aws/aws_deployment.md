# AuraDent AWS Deployment

This document covers the minimal AWS setup required to deploy the current AuraDent async backend and connect the gateway to the deployed queue.

## Scope

For the current implementation stage, AWS is used for:

- SQS for session-close messages
- Lambda for async worker execution
- IAM for Lambda execution and deployment permissions
- CloudFormation through AWS CDK
- CloudWatch Logs for worker logs
- CDK bootstrap resources in the target account and region

You do not need to manually create the application resources first. The CDK stack in [auradent-async-stack.ts](/Users/nataliep/Documents/New%20project/infra/aws/lib/auradent-async-stack.ts) creates the queue, DLQ, Lambda, and event source mapping.

## Deployment Checklist

1. Install and verify local tooling.

```bash
aws --version
npx cdk --version
```

2. Configure AWS credentials with either `aws configure` or AWS SSO.

3. Confirm your credentials are working.

```bash
aws sts get-caller-identity
```

4. Choose a deployment region.

The stack currently defaults to `us-west-2` in [auradent.ts](/Users/nataliep/Documents/New%20project/infra/aws/bin/auradent.ts) unless overridden by environment variables.

5. Set local AWS environment variables.

```bash
export AWS_PROFILE=your-profile
export AWS_REGION=us-west-2
export CDK_DEFAULT_REGION=us-west-2
```

6. Bootstrap CDK once per target account and region.

```bash
npx cdk bootstrap aws://YOUR_ACCOUNT_ID/us-west-2 --app "tsx infra/aws/bin/auradent.ts"
```

7. Run a local preflight verification pass.

```bash
npm run typecheck
npm run build
npm run synth --workspace @auradent/aws-infra
```

8. Deploy the async stack.

```bash
npm run deploy --workspace @auradent/aws-infra
```

9. Capture the CloudFormation outputs after deploy.

You will need:

- `SessionCloseQueueUrl`
- `SessionCloseQueueArn`

10. Point the gateway to the deployed queue.

```bash
export AURADENT_AWS_REGION=us-west-2
export AURADENT_SESSION_CLOSE_QUEUE_URL=PASTE_QUEUE_URL_HERE
```

If you want the worker to persist to PostgreSQL instead of the local file fallback, also set:

```bash
export AURADENT_DATABASE_URL=postgres://user:password@host:5432/auradent
export AURADENT_DATABASE_SSL=disable
```

11. Restart the local gateway and frontend.

```bash
npm run dev:gateway
npm run dev:web
```

12. Run a session and stop it to verify the enqueue path.

Expected checks:

- the gateway terminal shows a successful SQS publish
- the Lambda worker executes from the SQS trigger
- CloudWatch Logs show the worker processing the payload
- if `AURADENT_DATABASE_URL` is unset, the worker persists to `AURADENT_PERSISTENCE_FILE` or `/tmp/auradent-session-records.jsonl`

## Local Worker Testing

If you have not deployed to AWS yet, you can still run the worker locally against a saved `SessionClosePayload` JSON file:

```bash
npm run run:worker-local --workspace @auradent/worker -- /absolute/path/to/session-close-payload.json
```

Or from the repo root:

```bash
npm run run:worker-local -- /absolute/path/to/session-close-payload.json
```

The gateway also saves local replay files on `session.stop`:

- latest payload: [/Users/nataliep/Documents/New project/tmp/session-close/latest-session-close.json](/Users/nataliep/Documents/New%20project/tmp/session-close/latest-session-close.json)
- per-session payloads: [/Users/nataliep/Documents/New project/tmp/session-close](/Users/nataliep/Documents/New%20project/tmp/session-close)

So the fastest local replay flow is:

```bash
npm run run:worker-local -- "/Users/nataliep/Documents/New project/tmp/session-close/latest-session-close.json"
```

For local file persistence:

```bash
export AURADENT_PERSISTENCE_FILE=/Users/nataliep/Documents/New\ project/tmp/auradent-session-records.jsonl
```

For local PostgreSQL persistence:

```bash
export AURADENT_DATABASE_URL=postgres://user:password@localhost:5432/auradent
export AURADENT_DATABASE_SSL=disable
```

The local worker uses the same enrichment and persistence path as the Lambda worker.

To initialize the local AuraDent session table explicitly:

```bash
npm run migrate:worker-local
```

To inspect persisted records:

```bash
npm run readback:worker-local
```

To inspect one session:

```bash
npm run readback:worker-local -- demo-session
```

The checked-in SQL migration lives at [001_create_auradent_session_records.sql](/Users/nataliep/Documents/New%20project/apps/worker/sql/001_create_auradent_session_records.sql).

## Teardown

To remove the AuraDent async stack resources from AWS:

```bash
npm run destroy --workspace @auradent/aws-infra
```

This is the CDK equivalent of a stack destroy. It removes the AuraDent stack resources, including:

- session-close queue
- dead-letter queue
- worker Lambda
- event source mapping
- stack-managed IAM resources

It does not remove the shared CDK bootstrap resources in your account and region.

After destroy, also clear any local queue configuration:

```bash
unset AURADENT_SESSION_CLOSE_QUEUE_URL
```

## IAM Permissions Checklist

The AWS identity you use for `cdk bootstrap` and `cdk deploy` needs enough permission to create and update the current AuraDent stack and its supporting bootstrap assets.

Minimum practical permissions for the deployment identity:

- `cloudformation:*` on the deployed stack resources
- `iam:CreateRole`
- `iam:DeleteRole`
- `iam:GetRole`
- `iam:PassRole`
- `iam:AttachRolePolicy`
- `iam:DetachRolePolicy`
- `iam:PutRolePolicy`
- `iam:DeleteRolePolicy`
- `iam:TagRole`
- `iam:UntagRole`
- `lambda:CreateFunction`
- `lambda:UpdateFunctionCode`
- `lambda:UpdateFunctionConfiguration`
- `lambda:DeleteFunction`
- `lambda:GetFunction`
- `lambda:CreateEventSourceMapping`
- `lambda:UpdateEventSourceMapping`
- `lambda:DeleteEventSourceMapping`
- `lambda:GetEventSourceMapping`
- `sqs:CreateQueue`
- `sqs:DeleteQueue`
- `sqs:GetQueueAttributes`
- `sqs:GetQueueUrl`
- `sqs:SetQueueAttributes`
- `sqs:TagQueue`
- `sqs:UntagQueue`
- `logs:CreateLogGroup`
- `logs:DeleteLogGroup`
- `logs:PutRetentionPolicy`
- `logs:DescribeLogGroups`
- `s3:*` on the CDK bootstrap assets bucket used during deploy
- `ssm:GetParameter` for the CDK bootstrap version parameter

If your organization uses a tightly scoped deployment role, also verify:

- it can use the CDK bootstrap roles in the target account
- it can upload Lambda bundle assets to the bootstrap bucket
- it can read bootstrap metadata from SSM

## Runtime Permissions

The deployed Lambda execution role is created by CDK. The stack already grants the worker the SQS consume permissions it needs for the session-close queue.

For the local gateway to publish directly to SQS, the AWS credentials used by `apps/gateway` also need:

- `sqs:SendMessage`
- `sqs:GetQueueAttributes`
- `sqs:GetQueueUrl`

Those permissions can be scoped to the single deployed session-close queue.

## Notes

- You do not need to manually create SQS, Lambda, IAM roles, or the event source mapping before deploy.
- You do need a bootstrapped CDK environment in the target account and region.
- A future production setup will likely add RDS or Aurora PostgreSQL, Secrets Manager, and possibly S3-backed artifact storage for generated PDFs.
