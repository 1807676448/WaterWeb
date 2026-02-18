const dayjs = require('dayjs');
const { run, all } = require('../db');

function extractMetric(payload, key) {
  return payload?.params?.[key]?.value ?? null;
}

function normalizeDeviceId(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function parseRuntimeSeconds(statusPayload = {}) {
  const candidate = statusPayload.runtime_seconds
    ?? statusPayload.runtimeSeconds
    ?? statusPayload.runtime
    ?? statusPayload.uptime;

  if (candidate === null || candidate === undefined || candidate === '') {
    return null;
  }

  const value = Number(candidate);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function parseDeviceStatus(statusPayload = {}) {
  if (typeof statusPayload.online === 'boolean') {
    return statusPayload.online ? 'online' : 'offline';
  }

  const statusText = String(statusPayload.status || '').trim().toLowerCase();
  if (statusText === 'online' || statusText === 'offline') {
    return statusText;
  }
  return 'online';
}

async function saveWaterQuality(deviceId, payload) {
  const finalDeviceId = normalizeDeviceId(deviceId, payload?.device_id, payload?.deviceId, payload?.id);
  if (!finalDeviceId) {
    return;
  }

  const now = dayjs().toISOString();
  await run(
    `INSERT INTO water_quality (
      device_id, tds, cod, toc, uv254, ph, tem, tur, air_temp, air_hum, pressure, altitude, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      finalDeviceId,
      extractMetric(payload, 'TDS'),
      extractMetric(payload, 'COD'),
      extractMetric(payload, 'TOC'),
      extractMetric(payload, 'UV254'),
      extractMetric(payload, 'pH'),
      extractMetric(payload, 'Tem'),
      extractMetric(payload, 'Tur'),
      extractMetric(payload, 'air_temp'),
      extractMetric(payload, 'air_hum'),
      extractMetric(payload, 'pressure'),
      extractMetric(payload, 'altitude'),
      JSON.stringify(payload),
      now
    ]
  );

  await run(
    `INSERT INTO devices (device_id, status, runtime_seconds, last_seen, updated_at)
     VALUES (?, 'offline', 0, NULL, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       updated_at=excluded.updated_at`,
    [finalDeviceId, now]
  );
}

async function upsertDevice(deviceId, patch = {}) {
  const finalDeviceId = normalizeDeviceId(deviceId, patch.device_id, patch.deviceId, patch.id);
  if (!finalDeviceId) {
    return;
  }

  const now = dayjs().toISOString();
  const status = parseDeviceStatus(patch);
  const runtimeSeconds = parseRuntimeSeconds(patch);

  await run(
    `INSERT INTO devices (device_id, status, runtime_seconds, last_seen, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
      status=excluded.status,
      runtime_seconds=CASE
        WHEN excluded.runtime_seconds IS NOT NULL THEN excluded.runtime_seconds
        ELSE devices.runtime_seconds
      END,
      last_seen=excluded.last_seen,
      updated_at=excluded.updated_at`,
    [finalDeviceId, status, runtimeSeconds, now, now]
  );
}

async function updateDeviceStatus(deviceId, statusPayload = {}) {
  const finalDeviceId = normalizeDeviceId(
    deviceId,
    statusPayload.device_id,
    statusPayload.deviceId,
    statusPayload.id
  );

  await upsertDevice(finalDeviceId, {
    device_id: finalDeviceId,
    status: parseDeviceStatus(statusPayload),
    runtime_seconds: parseRuntimeSeconds(statusPayload)
  });
}

async function listDevices() {
  const rows = await all(
    `SELECT device_id, status, runtime_seconds, last_seen, updated_at
     FROM devices
     ORDER BY updated_at DESC`
  );

  const now = dayjs();
  return rows.map((row) => {
    const lastSeen = row.last_seen ? dayjs(row.last_seen) : null;
    const online = !!lastSeen && now.diff(lastSeen, 'second') <= 180;
    return {
      ...row,
      status: online ? 'online' : 'offline'
    };
  });
}

async function listMetrics({ deviceId, start, end, limit = 200 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const conditions = [];
  const params = [];

  if (deviceId) {
    conditions.push('device_id = ?');
    params.push(deviceId);
  }
  if (start) {
    conditions.push('created_at >= ?');
    params.push(start);
  }
  if (end) {
    conditions.push('created_at <= ?');
    params.push(end);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(safeLimit);

  return all(
    `SELECT id, device_id, tds, cod, toc, uv254, ph, tem, tur, air_temp, air_hum, pressure, altitude, raw_json, created_at
     FROM water_quality
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
    params
  );
}

async function latestWaterQuality(deviceId, count = 10) {
  const params = [];
  let where = '';
  if (deviceId) {
    where = 'WHERE device_id = ?';
    params.push(deviceId);
  }
  params.push(count);

  return all(
    `SELECT device_id, tds, cod, toc, uv254, ph, tem, tur, air_temp, air_hum, pressure, altitude, created_at
     FROM water_quality
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
    params
  );
}

async function listCommands({ deviceId, limit = 100 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const conditions = [];
  const params = [];

  if (deviceId) {
    conditions.push('device_id = ?');
    params.push(deviceId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(safeLimit);

  const rows = await all(
    `SELECT id, device_id, command, request_json, response_json, created_at
     FROM commands
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
    params
  );

  return rows.map((row) => {
    let parsedResponse = null;
    try {
      parsedResponse = row.response_json ? JSON.parse(row.response_json) : null;
    } catch (error) {
      parsedResponse = null;
    }

    const success = !!(parsedResponse && parsedResponse.ok !== false && !parsedResponse.error);
    return {
      ...row,
      execution_status: success ? 'success' : 'failed'
    };
  });
}

module.exports = {
  saveWaterQuality,
  updateDeviceStatus,
  listDevices,
  listMetrics,
  latestWaterQuality,
  listCommands
};
