import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE = process.env.RECOMMENDATIONS_TABLE || "screeps-advisor-recommendations";

/**
 * Cleanup stale pending recommendations.
 * - Marks pending recommendations older than 24 hours as 'expired'
 * - Safe to run multiple times (idempotent)
 */
export async function handler(event) {
  console.log("Cleanup recommendations invoked");

  const ONE_DAY_AGO = Date.now() - (24 * 60 * 60 * 1000);
  const FORTY_EIGHT_HOURS_AGO = Date.now() - (48 * 60 * 60 * 1000);

  let cleaned = 0;
  let expired = 0;
  let lastEvaluatedKey;

  do {
    // Scan for stale pending recommendations
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "#status = :pending AND createdAt < :cutoff",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pending": "pending",
        ":cutoff": ONE_DAY_AGO
      },
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    for (const item of result.Items || []) {
      // Mark as expired with timestamp
      const newStatus = item.createdAt < FORTY_EIGHT_HOURS_AGO ? "expired_stale" : "expired";

      await docClient.send(new UpdateCommand({
        TableName: TABLE,
        Key: { id: item.id },
        UpdateExpression: "SET #status = :expired, expiredAt = :now, expiredReason = :reason",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":expired": newStatus,
          ":now": Date.now(),
          ":reason": "cleanup_stale_pending"
        },
        ConditionExpression: "#status = :pending", // Only update if still pending
      })).catch(err => {
        // Ignore condition check failures (item already updated)
        if (err.name !== "ConditionalCheckFailedException") {
          throw err;
        }
      });

      cleaned++;
      if (newStatus === "expired_stale") expired++;

      console.log(`Cleaned recommendation ${item.id} (${item.roomName}): ${item.title || "untitled"}`);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`Cleanup complete: ${cleaned} recommendations cleaned (${expired} were very stale)`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      cleaned,
      expired,
      message: `Cleaned ${cleaned} stale recommendations`
    })
  };
}
