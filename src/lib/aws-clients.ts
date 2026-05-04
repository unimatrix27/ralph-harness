// aws-clients — typed wrappers around the AWS SDK clients the operator CLIs
// need. Centralized so every module shares the same region and credential
// chain, and so tests can inject mocks via the `AwsClients` interface.
//
// Region is forced to `eu-central-1` — matching the bash port and the rest
// of the harness. Override only via the explicit constructor argument (used
// by tests).

import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { IAMClient } from "@aws-sdk/client-iam";
import { KMSClient } from "@aws-sdk/client-kms";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";

export const AWS_REGION = "eu-central-1";

export interface AwsClients {
  kms: KMSClient;
  ssm: SSMClient;
  iam: IAMClient;
  ec2: EC2Client;
  logs: CloudWatchLogsClient;
  sts: STSClient;
}

export function defaultAwsClients(region: string = AWS_REGION): AwsClients {
  return {
    kms: new KMSClient({ region }),
    ssm: new SSMClient({ region }),
    iam: new IAMClient({ region }),
    ec2: new EC2Client({ region }),
    logs: new CloudWatchLogsClient({ region }),
    sts: new STSClient({ region }),
  };
}
