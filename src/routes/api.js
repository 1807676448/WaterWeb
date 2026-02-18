const express = require('express');
const { listMetrics, listDevices } = require('../services/deviceService');
const { handleDeviceCommand } = require('../services/mqttService');
const { analyzeLatestWaterQuality, latestAnalysisReport } = require('../services/deepseekService');

const router = express.Router();

router.get('/metrics', async (req, res) => {
  try {
    const { device_id: deviceId, start, end, limit } = req.query;
    const parsedLimit = Number(limit || 120);
    const data = await listMetrics({
      deviceId,
      start,
      end,
      limit: Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 120, 1), 300)
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

module.exports = router;
