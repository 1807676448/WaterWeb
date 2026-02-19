const express = require('express');
const multer = require('multer');
const config = require('../config');
const {
  listMetrics,
  listDevices,
  listCommands
} = require('../services/deviceService');
const { handleDeviceCommand } = require('../services/mqttService');
const { analyzeLatestWaterQuality, latestAnalysisReport } = require('../services/deepseekService');
const {
  writeImageBuffer,
  pruneOverflow,
  listRecentUploads
} = require('../services/imageUploadService');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.upload.maxContentLength
  }
});

function verifyUploadToken(req) {
  if (!config.upload.token) {
    return true;
  }
  return req.get('X-Upload-Token') === config.upload.token;
}

router.get('/metrics', async (req, res) => {
  try {
    const { device_id: deviceId, start, end, limit } = req.query;
    const parsedLimit = Number(limit || 120);
    const data = await listMetrics({
      deviceId,
      start,
      end,
      limit: Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 100, 1), 100)
    });
    res.json({ data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/devices', async (req, res) => {
  try {
    const data = await listDevices();
    res.json({ data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/commands', async (req, res) => {
  try {
    const { device_id: deviceId, limit } = req.query;
    const parsedLimit = Number(limit || 100);
    const data = await listCommands({
      deviceId,
      limit: Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 100, 1), 100)
    });
    res.json({ data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/iot/command', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.device_id || !payload.command) {
      res.status(400).json({ error: 'device_id 和 command 不能为空' });
      return;
    }

    const result = await handleDeviceCommand(payload);
    if (!result) {
      res.status(400).json({ error: '当前仅支持 command = time' });
      return;
    }

    res.json({ ok: true, downlink: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/analysis/deepseek', async (req, res) => {
  try {
    const { device_id: deviceId } = req.body || {};
    const result = await analyzeLatestWaterQuality(deviceId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: `DeepSeek 分析失败: ${error.message}` });
  }
});

router.get('/analysis/deepseek/latest', async (req, res) => {
  try {
    const { device_id: deviceId } = req.query;
    const report = await latestAnalysisReport(deviceId || '');
    res.json({ data: report });
  } catch (error) {
    res.status(500).json({ error: `查询分析历史失败: ${error.message}` });
  }
});

router.get('/uploads/recent', async (req, res) => {
  try {
    const rows = await listRecentUploads(config.upload.recentLimit);
    res.json({ data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/uploads', upload.single('image'), async (req, res) => {
  try {
    if (!verifyUploadToken(req)) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: '图片不能为空' });
      return;
    }

    const created = await writeImageBuffer({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      description: req.body?.description || ''
    });
    await pruneOverflow();

    res.status(201).json({ ok: true, data: created });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/upload', express.raw({ type: '*/*', limit: config.upload.maxContentLength }), async (req, res) => {
  try {
    if (!verifyUploadToken(req)) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    const fileName = String(req.get('X-File-Name') || '').trim();
    if (!fileName) {
      res.status(400).json({ error: 'X-File-Name 不能为空' });
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const created = await writeImageBuffer({
      buffer: body,
      originalName: fileName,
      contentType: req.get('Content-Type') || 'application/octet-stream',
      description: req.get('X-Description') || ''
    });
    await pruneOverflow();

    res.status(201).json({ ok: true, data: created });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
