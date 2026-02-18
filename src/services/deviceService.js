const dayjs = require('dayjs');
const { run, all } = require('../db');

function extractMetric(payload, key) {
  return payload?.params?.[key]?.value ?? null;
}

async function saveWaterQuality(deviceId, payload) {
  const now = dayjs().toISOString();
  await run(
    `INSERT INTO water_quality (
      device_id, tds, cod, toc, uv254, ph, tem, tur, air_temp, air_hum, pressure, altitude, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      deviceId,
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

  await upsertDevice(deviceId, { status: 'online' });
}

async function upsertDevice(deviceId, patch = {}) {
  const now = dayjs().toISOString();
  const status = patch.status || 'online';
  const runtimeSeconds = Number(patch.runtime_seconds ?? 0);

  await run(
    `INSERT INTO devices (device_id, status, runtime_seconds, last_seen, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
      status=excluded.status,
      runtime_seconds=CASE
        WHEN excluded.runtime_seconds > 0 THEN excluded.runtime_seconds
        ELSE devices.runtime_seconds
      END,
      last_seen=excluded.last_seen,
      updated_at=excluded.updated_at`,
    [deviceId, status, runtimeSeconds, now, now]
  );
}

async function updateDeviceStatus(deviceId, statusPayload = {}) {
  await upsertDevice(deviceId, {
    status: statusPayload.status || 'online',
    runtime_seconds: statusPayload.runtime_seconds
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
    const online = !!lastSeen && now.diff(lastSeen, 'second') <= 120;
    return {
      ...row,
      status: online ? 'online' : row.status || 'offline'
    };
  });
}

async function listMetrics({ deviceId, start, end, limit = 200 }) {
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
  params.push(limit);

  return all(
    `SELECT id, device_id, tds, cod, toc, uv254, ph, tem, tur, air_temp, air_hum, pressure, altitude, created_at
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

module.exports = {
  saveWaterQuality,
  updateDeviceStatus,
  listDevices,
  listMetrics,
  latestWaterQuality
};
