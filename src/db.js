const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const config = require('./config');

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(config.dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS water_quality (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      tds REAL,
      cod REAL,
      toc REAL,
      uv254 REAL,
      ph REAL,
      tem REAL,
      tur REAL,
      air_temp REAL,
      air_hum REAL,
      pressure REAL,
      altitude REAL,
      raw_json TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'offline',
      runtime_seconds INTEGER DEFAULT 0,
      last_seen TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      command TEXT NOT NULL,
      request_json TEXT,
      response_json TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS analysis_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      model TEXT NOT NULL,
      sample_count INTEGER NOT NULL,
      message_markdown TEXT NOT NULL,
      raw_data_json TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_analysis_reports_created_at
    ON analysis_reports(created_at DESC)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_analysis_reports_device_id
    ON analysis_reports(device_id)
  `);
}

module.exports = {
  db,
  run,
  all,
  get,
  initDb
};
