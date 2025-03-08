import * as cdk from "aws-cdk-lib";
import { RemovalPolicy } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

interface Props {
  OPENAI_API_KEY: string;
}

class FaaiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, {});

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

    // Removal policy
    rest.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // Create the /chat resource
    const chat = rest.root.addResource("chat");

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
    })

    // Add POST method with the OpenAI integration
    chat.addMethod("POST", integration, {
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
  }
}

const OPENAI_API_KEY: string | undefined = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

const app = new cdk.App();
new FaaiStack(app, "faai", { OPENAI_API_KEY });
