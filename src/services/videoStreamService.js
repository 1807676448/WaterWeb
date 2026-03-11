const dayjs = require('dayjs');
const config = require('../config');
const { run, all } = require('../db');

const STREAM_NAME_RE = /^[a-zA-Z0-9/_-]{3,120}$/;
const DEVICE_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeDeviceId(deviceId) {
  const id = normalizeString(deviceId);
  if (!id) {
    throw new Error('device_id 不能为空');
  }
  if (!DEVICE_ID_RE.test(id)) {
    throw new Error('device_id 格式非法，仅支持字母数字._-');
  }
  return id;
}

function normalizeStreamName(streamName, deviceId) {
  const custom = normalizeString(streamName).replace(/^\/+/, '');
  const fallback = `${config.video.streamPrefix}/${deviceId}`;
  const finalName = (custom || fallback).replace(/\/{2,}/g, '/');

  if (!STREAM_NAME_RE.test(finalName)) {
    throw new Error('stream_name 格式非法，仅支持字母数字/_-');
  }

  return finalName;
}

function normalizeNumber(value, min, max) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(Math.max(parsed, min), max);
}

function parseIso(isoText) {
  const parsed = new Date(isoText || '');
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function withUrl(baseUrl, suffix) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  const path = String(suffix || '').replace(/^\//, '');
  return `${root}/${path}`;
}

function normalizeStatus(statusText) {
  const status = normalizeString(statusText).toLowerCase();
  return status === 'offline' ? 'offline' : 'online';
}

async function upsertStreamHeartbeat(payload = {}) {
  const deviceId = normalizeDeviceId(payload.device_id || payload.deviceId);
  const streamName = normalizeStreamName(payload.stream_name || payload.streamName, deviceId);
  const status = normalizeStatus(payload.status || 'online');

  const codec = normalizeString(payload.codec || 'h264').slice(0, 32) || 'h264';
  const source = normalizeString(payload.source || 'k230').slice(0, 64) || 'k230';
  const width = normalizeNumber(payload.width, 16, 7680);
  const height = normalizeNumber(payload.height, 16, 4320);
  const fps = normalizeNumber(payload.fps, 1, 120);
  const bitrateKbps = normalizeNumber(payload.bitrate_kbps || payload.bitrateKbps, 1, 200000);

  const now = dayjs().toISOString();

  await run(
    `INSERT INTO video_streams(
      device_id, stream_name, status, codec, width, height, fps, bitrate_kbps, source, last_heartbeat_at, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stream_name)
    DO UPDATE SET
      device_id=excluded.device_id,
      status=excluded.status,
      codec=excluded.codec,
      width=excluded.width,
      height=excluded.height,
      fps=excluded.fps,
      bitrate_kbps=excluded.bitrate_kbps,
      source=excluded.source,
      last_heartbeat_at=excluded.last_heartbeat_at,
      updated_at=excluded.updated_at`,
    [
      deviceId,
      streamName,
      status,
      codec,
      width,
      height,
      fps,
      bitrateKbps,
      source,
      now,
      now,
      now
    ]
  );

  const [stream] = await listStreams({ streamName, limit: 1 });
  return stream;
}

function mapStreamRow(row) {
  const now = Date.now();
  const heartbeat = parseIso(row.last_heartbeat_at);
  const ageMs = heartbeat ? Math.max(now - heartbeat.getTime(), 0) : null;
  const stale = ageMs !== null && ageMs > config.video.heartbeatOfflineMs;
  const status = stale ? 'offline' : normalizeStatus(row.status);
  const streamName = String(row.stream_name || '');

  return {
    id: row.id,
    device_id: row.device_id,
    stream_name: streamName,
    status,
    codec: row.codec || 'h264',
    width: row.width || null,
    height: row.height || null,
    fps: row.fps || null,
    bitrate_kbps: row.bitrate_kbps || null,
    source: row.source || 'k230',
    last_heartbeat_at: row.last_heartbeat_at,
    updated_at: row.updated_at,
    stale_ms: ageMs,
    playback: {
      rtsp_url: withUrl(config.video.publicRtspBaseUrl, streamName),
      webrtc_whep_url: withUrl(config.video.publicWebrtcBaseUrl, `${streamName}/whep`),
      hls_url: withUrl(config.video.publicHlsBaseUrl, `${streamName}/index.m3u8`)
    }
  };
}

async function listStreams({ deviceId = '', streamName = '', limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const conditions = [];
  const params = [];

  const normalizedDevice = normalizeString(deviceId);
  if (normalizedDevice) {
    conditions.push('device_id = ?');
    params.push(normalizedDevice);
  }

  const normalizedStream = normalizeString(streamName);
  if (normalizedStream) {
    conditions.push('stream_name = ?');
    params.push(normalizedStream);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await all(
    `SELECT id, device_id, stream_name, status, codec, width, height, fps, bitrate_kbps, source, last_heartbeat_at, updated_at
     FROM video_streams
     ${where}
     ORDER BY updated_at DESC
     LIMIT ?`,
    [...params, safeLimit]
  );

  return rows.map(mapStreamRow);
}

module.exports = {
  upsertStreamHeartbeat,
  listStreams
};
