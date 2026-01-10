/**
 * Screeps Monitor Lambda
 * Checks colony health hourly and sends SMS alerts via SNS
 */

const https = require('https');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });

async function fetchSummary(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/summary`);

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'GET',
      timeout: 10000
    };

    const protocol = url.protocol === 'https:' ? https : require('http');

    const req = protocol.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function sendAlert(message) {
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) {
    console.error('SNS_TOPIC_ARN not configured');
    return;
  }

  await sns.send(new PublishCommand({
    TopicArn: topicArn,
    Message: message,
    Subject: 'Screeps Alert',
  }));

  console.log('Alert sent:', message);
}

exports.handler = async (event) => {
  const apiEndpoint = process.env.API_ENDPOINT;

  if (!apiEndpoint) {
    console.error('API_ENDPOINT not configured');
    return { statusCode: 500, body: 'API_ENDPOINT not configured' };
  }

  try {
    console.log(`Checking colony health at ${apiEndpoint}`);
    const summary = await fetchSummary(apiEndpoint);

    const criticalAlerts = [];

    // No creeps = colony dead
    if (summary.creeps.total === 0) {
      criticalAlerts.push('CRITICAL: No creeps alive! Colony may be dead.');
    }

    // Low bucket = CPU issues
    if (summary.stats && summary.stats.bucket < 5000) {
      criticalAlerts.push(`WARNING: Low CPU bucket (${summary.stats.bucket}/10000)`);
    }

    // Hostiles detected
    for (const room of summary.rooms) {
      if (room.hostiles > 0) {
        criticalAlerts.push(`ALERT: ${room.hostiles} hostile(s) in ${room.name}`);
      }
    }

    // Include any alerts from the API
    if (summary.alerts) {
      for (const alert of summary.alerts) {
        if (!criticalAlerts.some(c => c.includes(alert))) {
          criticalAlerts.push(alert);
        }
      }
    }

    // Send SMS if there are issues
    if (criticalAlerts.length > 0) {
      const message = [
        'Screeps Colony Alert',
        '---',
        ...criticalAlerts,
        '',
        `Tick: ${summary.stats?.tick || 'unknown'}`,
        `Creeps: ${summary.creeps.total}`,
        `Bucket: ${summary.stats?.bucket || 'unknown'}`,
      ].join('\n');

      await sendAlert(message);

      return {
        statusCode: 200,
        body: JSON.stringify({ alertsSent: criticalAlerts.length, alerts: criticalAlerts }),
      };
    }

    console.log('Colony healthy - no alerts');
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'healthy',
        creeps: summary.creeps.total,
        bucket: summary.stats?.bucket,
      }),
    };

  } catch (error) {
    const errorMessage = `Failed to check colony health: ${error}`;
    console.error(errorMessage);

    // Send alert on API failure too
    await sendAlert(`Screeps Monitor Error: ${errorMessage}`);

    return { statusCode: 500, body: errorMessage };
  }
};
