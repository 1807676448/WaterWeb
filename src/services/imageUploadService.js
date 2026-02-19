const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { run, all } = require('../db');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizeFileName(fileName = '') {
  const base = String(fileName).trim().replace(/[\\/]+/g, '_');
  if (!base) {
    throw new Error('文件名不能为空');
  }
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function guessImageByName(fileName) {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function validateImage(fileName, contentType) {
  const byType = String(contentType || '').toLowerCase().startsWith('image/');
  const byName = guessImageByName(fileName);
  if (!byType && !byName) {
    throw new Error('仅支持图片文件');
  }
}

function makeStoredFileName(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const stamp = Date.now();
  const nonce = crypto.randomBytes(4).toString('hex');
  return `${stamp}_${nonce}${ext}`;
}

async function writeImageBuffer({ buffer, originalName, contentType, description = '' }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('上传内容不能为空');
  }

  const safeOriginalName = sanitizeFileName(originalName);
  validateImage(safeOriginalName, contentType);

  ensureDirSync(config.upload.uploadDir);
  const storedName = makeStoredFileName(safeOriginalName);
  const absolutePath = path.join(config.upload.uploadDir, storedName);

  await fsp.writeFile(absolutePath, buffer);

  const createdAt = new Date().toISOString();
  const result = await run(
    `INSERT INTO image_uploads(file_name, description, content_type, file_size, file_path, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
    [
      safeOriginalName,
      String(description || '').trim().slice(0, 500),
      String(contentType || '').trim() || 'application/octet-stream',
      buffer.length,
      absolutePath,
      createdAt
    ]
  );

  return {
    id: result.id,
    file_name: safeOriginalName,
    description: String(description || '').trim().slice(0, 500),
    content_type: String(contentType || '').trim() || 'application/octet-stream',
    file_size: buffer.length,
    created_at: createdAt,
    public_url: `${config.upload.publicBasePath.replace(/\/$/, '')}/${storedName}`
  };
}

async function pruneOverflow() {
  const max = config.upload.maxStoredImages;
  const rows = await all(
    `SELECT id, file_path
     FROM image_uploads
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT -1 OFFSET ?`,
    [max]
  );

  if (!rows.length) {
    return { removed: 0 };
  }

  for (const row of rows) {
    try {
      await fsp.unlink(row.file_path);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
    }
    await run('DELETE FROM image_uploads WHERE id = ?', [row.id]);
  }

  return { removed: rows.length };
}

async function listRecentUploads(limit = config.upload.recentLimit) {
  const safeLimit = Math.min(Math.max(Number(limit) || config.upload.recentLimit, 1), config.upload.recentLimit);
  const rows = await all(
    `SELECT id, file_name, description, content_type, file_size, file_path, created_at
     FROM image_uploads
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT ?`,
    [safeLimit]
  );

  return rows.map((row) => ({
    id: row.id,
    file_name: row.file_name,
    description: row.description || '',
    content_type: row.content_type || '',
    file_size: row.file_size || 0,
    created_at: row.created_at,
    public_url: `${config.upload.publicBasePath.replace(/\/$/, '')}/${path.basename(row.file_path)}`
  }));
}

module.exports = {
  ensureDirSync,
  writeImageBuffer,
  pruneOverflow,
  listRecentUploads
};
