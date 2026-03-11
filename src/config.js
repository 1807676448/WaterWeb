const path = require('path');

const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './data/uploads');

module.exports = {
  port: Number(process.env.PORT || 3000),
  mqtt: {
    url: process.env.MQTT_URL || 'mqtt://127.0.0.1:1883',
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: process.env.MQTT_CLIENT_ID || 'water-platform-server',
    uplinkTopic: process.env.MQTT_UPLINK_TOPIC || 'devices/+/up',
    statusTopic: process.env.MQTT_STATUS_TOPIC || 'devices/+/status',
    commandTopic: process.env.MQTT_COMMAND_TOPIC || 'devices/+/command',
    downlinkTopicTemplate: process.env.MQTT_DOWNLINK_TOPIC_TEMPLATE || 'devices/{device_id}/down'
  },
  dbPath: path.resolve(process.cwd(), process.env.DB_PATH || './data/water_quality.db'),
  upload: {
    token: process.env.UPLOAD_TOKEN || '',
    uploadDir,
    publicBasePath: process.env.PUBLIC_BASE_PATH || '/uploads',
    maxContentLength: Number(process.env.MAX_CONTENT_LENGTH || 10 * 1024 * 1024),
    maxStoredImages: Math.max(Number(process.env.MAX_STORED_IMAGES || 100), 1),
    recentLimit: Math.max(Number(process.env.RECENT_IMAGE_LIMIT || 10), 1)
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  },
  video: {
    enabled: String(process.env.VIDEO_ENABLED || 'true').toLowerCase() !== 'false',
    streamPrefix: process.env.VIDEO_STREAM_PREFIX || 'live',
    heartbeatOfflineMs: Math.max(Number(process.env.VIDEO_HEARTBEAT_OFFLINE_MS || 15000), 3000),
    publicRtspBaseUrl: process.env.VIDEO_PUBLIC_RTSP_BASE_URL || 'rtsp://127.0.0.1:8554',
    publicWebrtcBaseUrl: process.env.VIDEO_PUBLIC_WEBRTC_BASE_URL || '/mtx-webrtc',
    publicHlsBaseUrl: process.env.VIDEO_PUBLIC_HLS_BASE_URL || '/mtx-hls'
  }
};
