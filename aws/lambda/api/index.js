import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;
const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE;

// Route handlers
async function getSummary(roomName) {
  const since = Date.now() - (60 * 60 * 1000); // Last hour

  const snapshots = await docClient.send(new QueryCommand({
    TableName: SNAPSHOTS_TABLE,
    KeyConditionExpression: 'roomName = :room AND #ts > :since',
    ExpressionAttributeNames: { '#ts': 'timestamp' },
    ExpressionAttributeValues: { ':room': roomName, ':since': since },
    ScanIndexForward: false,
    Limit: 1,
  }));

  const recommendations = await docClient.send(new QueryCommand({
    TableName: RECOMMENDATIONS_TABLE,
    IndexName: 'room-index',
    KeyConditionExpression: 'roomName = :room',
    ExpressionAttributeValues: { ':room': roomName },
    ScanIndexForward: false,
    Limit: 10,
  }));

  const latest = snapshots.Items?.[0];
  const pending = recommendations.Items?.filter(r => r.status === 'pending') || [];

  return {
    roomName,
    snapshot: latest || null,
    recommendations: pending,
    recommendationCount: pending.length,
  };
}

async function getRecommendations(roomName) {
  const response = await docClient.send(new QueryCommand({
    TableName: RECOMMENDATIONS_TABLE,
    IndexName: 'room-index',
    KeyConditionExpression: 'roomName = :room',
    ExpressionAttributeValues: { ':room': roomName },
    ScanIndexForward: false,
    Limit: 50,
  }));

  return response.Items || [];
}

async function getMetricHistory(roomName, hours = 24) {
  const since = Date.now() - (hours * 60 * 60 * 1000);

  const response = await docClient.send(new QueryCommand({
    TableName: SNAPSHOTS_TABLE,
    KeyConditionExpression: 'roomName = :room AND #ts > :since',
    ExpressionAttributeNames: { '#ts': 'timestamp' },
    ExpressionAttributeValues: { ':room': roomName, ':since': since },
    ScanIndexForward: true,
  }));

  return response.Items || [];
}

async function submitFeedback(recommendationId, feedback) {
  await docClient.send(new UpdateCommand({
    TableName: RECOMMENDATIONS_TABLE,
    Key: { id: recommendationId },
    UpdateExpression: 'SET #status = :status, feedback = :feedback, feedbackAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': feedback.action,
      ':feedback': feedback,
      ':now': Date.now(),
    },
  }));

  return { success: true };
}

export async function handler(event) {
  console.log('API request:', event.routeKey, event.pathParameters);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const path = event.routeKey;
    const params = event.pathParameters || {};
    const query = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};

    let result;

    if (path === 'GET /summary/{roomName}') {
      result = await getSummary(params.roomName);
    }
    else if (path === 'GET /recommendations/{roomName}') {
      result = await getRecommendations(params.roomName);
    }
    else if (path === 'GET /metrics/{roomName}') {
      const hours = parseInt(query.hours) || 24;
      result = await getMetricHistory(params.roomName, hours);
    }
    else if (path === 'POST /feedback/{recommendationId}') {
      result = await submitFeedback(params.recommendationId, body);
    }
    else {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Not found' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result),
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
}
