const axios = require('axios');
const config = require('../config');
const { latestWaterQuality } = require('./deviceService');
const { run, get } = require('../db');

async function saveAnalysisReport({ deviceId, model, sampleCount, message, rawData }) {
  const result = await run(
    `INSERT INTO analysis_reports (
      device_id, model, sample_count, message_markdown, raw_data_json, created_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [
      deviceId || null,
      model,
      sampleCount,
      message,
      rawData ? JSON.stringify(rawData) : null
    ]
  );

  return result.id;
}

async function latestAnalysisReport(deviceId) {
  const where = deviceId ? 'WHERE device_id = ?' : '';
  const params = deviceId ? [deviceId] : [];

  const row = await get(
    `SELECT id, device_id, model, sample_count, message_markdown, created_at
     FROM analysis_reports
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    params
  );

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    device_id: row.device_id,
    model: row.model,
    sampleCount: row.sample_count,
    message: row.message_markdown,
    created_at: row.created_at
  };
}

async function analyzeLatestWaterQuality(deviceId) {
  const latestData = await latestWaterQuality(deviceId, 10);

  if (!latestData.length) {
    return {
      message: '暂无可分析的数据，请先接入设备上报。',
      sampleCount: 0,
      model: config.deepseek.model
    };
  }

  if (!config.deepseek.apiKey) {
    const localResult = {
      message: '未配置 DEEPSEEK_API_KEY，以下为本地提示：最近数据已接收，建议重点关注 pH、COD、TDS 的连续波动趋势。',
      sampleCount: latestData.length,
      model: 'local-fallback',
      rawData: latestData
    };

    const reportId = await saveAnalysisReport({
      deviceId,
      model: localResult.model,
      sampleCount: localResult.sampleCount,
      message: localResult.message,
      rawData: latestData
    });

    return {
      ...localResult,
      reportId
    };
  }

  const prompt = {
    instruction: '请基于以下最近10次水质监测数据，给出简明专业分析，包括整体趋势、异常指标、可能原因和处理建议。',
    data: latestData
  };

  const response = await axios.post(
    `${config.deepseek.baseUrl}/chat/completions`,
    {
      model: config.deepseek.model,
      messages: [
        {
          role: 'system',
          content: '你是水质分析专家，请使用中文输出，结构清晰，结论可执行。'
        },
        {
          role: 'user',
          content: JSON.stringify(prompt)
        }
      ],
      temperature: 0.2
    },
    {
      headers: {
        Authorization: `Bearer ${config.deepseek.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  const message = response.data?.choices?.[0]?.message?.content || 'DeepSeek 未返回有效分析结果。';
  const result = {
    message,
    sampleCount: latestData.length,
    model: config.deepseek.model,
    rawData: latestData
  };

  const reportId = await saveAnalysisReport({
    deviceId,
    model: result.model,
    sampleCount: result.sampleCount,
    message: result.message,
    rawData: latestData
  });

  return {
    ...result,
    reportId
  };
}

module.exports = {
  analyzeLatestWaterQuality,
  latestAnalysisReport
};
