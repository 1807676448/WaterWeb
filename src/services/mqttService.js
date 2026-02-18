const mqtt = require('mqtt');
const dayjs = require('dayjs');
const config = require('../config');
const { run } = require('../db');
const {
  saveWaterQuality,
  updateDeviceStatus
} = require('./deviceService');

let client;

function topicDeviceId(topic) {
  const parts = topic.split('/');
  return parts.length >= 2 ? parts[1] : '';
}

function resolveDeviceId(topic, payload = {}) {
  return String(
    topicDeviceId(topic)
    || payload.device_id
    || payload.deviceId
    || payload.id
    || ''
  ).trim();
}

async function handleDeviceCommand(commandPayload, sourceDeviceId) {
  const deviceId = commandPayload.device_id || sourceDeviceId;
  if (!deviceId || commandPayload.command !== 'time') {
    return null;
  }

  const response = {
    timestamp: Date.now()
  };

  const downTopic = config.mqtt.downlinkTopicTemplate.replace('{device_id}', deviceId);
  client.publish(downTopic, JSON.stringify(response), { qos: 1 });

  await run(
    `INSERT INTO commands(device_id, command, request_json, response_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      deviceId,
      commandPayload.command,
      JSON.stringify(commandPayload),
      JSON.stringify(response),
      dayjs().toISOString()
    ]
  );

  return response;
}

function connectMqtt() {
  client = mqtt.connect(config.mqtt.url, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: `${config.mqtt.clientId}-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 3000
  });

  client.on('connect', () => {
    console.log('[MQTT] connected');
    client.subscribe(config.mqtt.uplinkTopic, { qos: 1 });
    client.subscribe(config.mqtt.statusTopic, { qos: 1 });
    client.subscribe(config.mqtt.commandTopic, { qos: 1 });
  });

  client.on('message', async (topic, payloadBuffer) => {
    const payloadText = payloadBuffer.toString('utf-8');

    try {
      const payload = JSON.parse(payloadText);
      const deviceId = resolveDeviceId(topic, payload);

      if (topic.includes('/up')) {
        await saveWaterQuality(deviceId, payload);
        return;
      }

      if (topic.includes('/status')) {
        await updateDeviceStatus(deviceId, payload);
        return;
      }

      if (topic.includes('/command')) {
        await handleDeviceCommand(payload, deviceId);
      }
    } catch (error) {
      console.error('[MQTT] message handle error:', error.message, payloadText);
    }
  });

  client.on('error', (error) => {
    console.error('[MQTT] error:', error.message);
  });
}

module.exports = {
  connectMqtt,
  handleDeviceCommand
};
