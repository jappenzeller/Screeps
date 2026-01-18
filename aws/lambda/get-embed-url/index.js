import {
  QuickSightClient,
  GenerateEmbedUrlForRegisteredUserCommand
} from "@aws-sdk/client-quicksight";

const quicksight = new QuickSightClient({});

const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;
const DASHBOARD_ID = process.env.QUICKSIGHT_DASHBOARD_ID;
const QUICKSIGHT_NAMESPACE = "default";
// Use existing AUTHOR user who has full permissions
const QUICKSIGHT_USER = "jappenzeller";

export async function handler(event) {
  console.log("Event:", JSON.stringify(event, null, 2));

  // Verify Cognito authentication
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims) {
    return {
      statusCode: 401,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Unauthorized" })
    };
  }

  const userEmail = claims.email;
  console.log(`Generating embed URL for authenticated user: ${userEmail}`);

  try {
    // Generate embed URL using the shared AUTHOR user
    // Cognito handles authentication, QuickSight AUTHOR provides data access
    const command = new GenerateEmbedUrlForRegisteredUserCommand({
      AwsAccountId: AWS_ACCOUNT_ID,
      UserArn: `arn:aws:quicksight:us-east-1:${AWS_ACCOUNT_ID}:user/${QUICKSIGHT_NAMESPACE}/${QUICKSIGHT_USER}`,
      ExperienceConfiguration: {
        Dashboard: {
          InitialDashboardId: DASHBOARD_ID,
        },
      },
      SessionLifetimeInMinutes: 600,
      AllowedDomains: [
        "https://screeps-dashboard-488218643044.s3.amazonaws.com",
        "http://localhost:8080"
      ],
    });

    const response = await quicksight.send(command);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embedUrl: response.EmbedUrl,
      }),
    };
  } catch (error) {
    console.error("Error generating embed URL:", error);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Failed to generate embed URL", details: error.message }),
    };
  }
}
