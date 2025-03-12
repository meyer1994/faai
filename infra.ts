import * as cdk from "aws-cdk-lib";
import { RemovalPolicy } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as logs from "aws-cdk-lib/aws-logs";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

interface Props {
  OPENAI_API_KEY: string;
}

class FaaiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, {});

    // Rest API
    const rest = new apigateway.RestApi(this, `${id}-rest`, {
      restApiName: `${id}-rest`,
      description: "Proxy API for OpenAI requests",
      // Deployment
      deploy: true,
      retainDeployments: false,
      // Method
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.NONE,
      },
      deployOptions: {
        // Throttling
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        // Debugging
        metricsEnabled: true,
        tracingEnabled: true,
        dataTraceEnabled: true,
        // Logging
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new cdk.aws_logs.LogGroup(this, `${id}-rest-access-log`, {
            logGroupName: `${id}-rest-access-log`,
            retention: RetentionDays.THREE_DAYS,
            removalPolicy: RemovalPolicy.DESTROY,
          })
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          ip: true,
          caller: true,
          user: true,
          requestTime: true,
          httpMethod: true,
          resourcePath: true,
          status: true,
          protocol: true,
          responseLength: true,
        }),
        // OpenAI API Key
        variables: {
          OPENAI_API_KEY: props.OPENAI_API_KEY,
        },
      },
      // Cors
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
      },
      // Cloudwatch
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.DESTROY,
    });

    // Removal policy, clean up!
    rest.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // Gets the stage. Used later for metrics
    const stage = apigateway.Stage.fromStageAttributes(this, `${id}-stage`, {
      stageName: "prod",
      restApi: rest,
    });

    // Undocumented hack that allows you to create the execution log before
    // performing the first request. The log group is created only on the first
    // request by API Gateway. By creating one with the same name as the log
    // group, we can ensure that the log group is created before the first
    // request and apply all configurations we want.
    const log = new logs.LogGroup(this, `${id}-logs`, {
      logGroupName: `API-Gateway-Execution-Logs_${rest.restApiId}/${stage.stageName}`,
      retention: RetentionDays.THREE_DAYS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Create the /chat resource (path)
    const resource = rest.root.addResource("chat");

    // Create integration with OpenAI API
    const integration = new apigateway.Integration({
      type: apigateway.IntegrationType.HTTP,
      integrationHttpMethod: "POST",
      uri: "https://api.openai.com/v1/chat/completions",
      options: {
        // maps:
        //
        // `{role: string, content: string}[]`
        // to
        // `{model: string, temperature: number, messages: {role: string, content: string}[]}`
        requestTemplates: {
          "application/json": `
          #set($inputRoot = $input.path('$'))
          {
            "model": "gpt-4o-mini",
            "temperature": 0.7,
            "messages": $input.json('$.messages')
          }
          `,
        },
        // Authorization header
        requestParameters: {
          "integration.request.header.Content-Type": "'application/json'",
          "integration.request.header.Authorization": `'Bearer ${props.OPENAI_API_KEY}'`,
        },
        // Responses
        integrationResponses: [
          {
            statusCode: "200",
            // needed for CORS
            responseParameters: {
              "method.response.header.Access-Control-Allow-Origin": "'*'",
            },
            // maps:
            //
            // `{choices: {message: {role: string, content: string}}[]}`
            // to
            // `{role: string, content: string}`
            responseTemplates: {
              "application/json": `
              #set($inputRoot = $input.path('$'))
              $input.json('$.choices[0].message')
              `,
            },
          },
          {
            statusCode: "400",
            selectionPattern: "4\\d{2}",
            // needed for CORS
            responseParameters: {
              "method.response.header.Access-Control-Allow-Origin": "'*'",
            },
            // maps:
            //
            // `{error: {message: string}}`
            // to
            // `{error: string}`
            responseTemplates: {
              "application/json": `
              #set($inputRoot = $input.path('$'))
              {
                "error": $input.json('$.error.message')
              }
              `,
            },
          },
          {
            statusCode: "500",
            selectionPattern: "5\\d{2}",
            // needed for CORS
            responseParameters: {
              "method.response.header.Access-Control-Allow-Origin": "'*'",
            },
            // maps:
            //
            // `{error: {message: string}}`
            // to
            // `{error: string}`
            responseTemplates: {
              "application/json": `
              #set($inputRoot = $input.path('$'))
              {
                "error": $input.json('$.error.message')
              }
              `,
            },
          },
        ],
      },
    });

    // Add request model that will be used for the POST method
    const request = rest.addModel("request", {
      modelName: "request",
      contentType: "application/json",
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ["messages"],
        properties: {
          messages: {
            type: apigateway.JsonSchemaType.ARRAY,
            required: ["role", "content"],
            items: {
              type: apigateway.JsonSchemaType.OBJECT,
              properties: {
                role: { type: apigateway.JsonSchemaType.STRING },
                content: { type: apigateway.JsonSchemaType.STRING },
              },
            },
          },
        },
      },
    });

    // Add POST method with the OpenAI integration
    const method = resource.addMethod("POST", integration, {
      // validator
      requestValidatorOptions: {
        requestValidatorName: "validator",
        validateRequestBody: true,
        validateRequestParameters: false,
      },
      requestModels: {
        "application/json": request,
      },
      // needed for CORS
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
        {
          statusCode: "400",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
        {
          statusCode: "500",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        },
      ],
    });

    // Create CloudWatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, `${id}-dashboard`, {
      dashboardName: `${id}-metrics`,
    });

    // Row 1 - Each call to `addWidgets` adds a new row to the dashboard
    dashboard.addWidgets(
      // Total Requests
      new cloudwatch.GraphWidget({
        title: "Requests",
        left: [rest.metricCount(), method.metricCount(stage)],
        width: 8,
      }),
      // Total Errors
      new cloudwatch.GraphWidget({
        title: "Errors",
        left: [rest.metricClientError(), rest.metricServerError()],
        width: 8,
      }),
      // Latency
      new cloudwatch.GraphWidget({
        title: "Latency",
        left: [rest.metricLatency(), rest.metricIntegrationLatency()],
        width: 8,
      })
    );

    // Row 2
    dashboard.addWidgets(
      // Logs
      new cloudwatch.LogQueryWidget({
        title: "Logs",
        logGroupNames: [log.logGroupName],
        queryLines: [
          "fields @timestamp, @message, @logStream, @log",
          "sort @timestamp desc",
          "limit 100",
        ],
        width: 24,
      })
    );
  }
}

const OPENAI_API_KEY: string | undefined = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

const app = new cdk.App();
new FaaiStack(app, "faai", { OPENAI_API_KEY });
