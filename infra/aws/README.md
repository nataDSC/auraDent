# AWS Infrastructure

This package contains the AWS CDK scaffold for AuraDent's async backend.

Deployment guide:

- [aws_deployment.md](/Users/nataliep/Documents/New%20project/infra/aws/aws_deployment.md)

Current scope:

- session-close queue,
- dead-letter queue,
- bundled worker Lambda function from `apps/worker/src/index.ts`,
- queue-to-worker event source mapping.

Current deployment commands:

```bash
npm run synth --workspace @auradent/aws-infra
```

```bash
npm run deploy --workspace @auradent/aws-infra
```

```bash
npm run destroy --workspace @auradent/aws-infra
```

Next step:

- add post-op PDF generation, insurance pre-auth, and final database persistence inside the worker path.
