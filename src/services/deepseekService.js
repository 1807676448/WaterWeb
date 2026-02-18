const axios = require('axios');
const config = require('../config');
const { latestWaterQuality } = require('./deviceService');

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
    return {
      message: '未配置 DEEPSEEK_API_KEY，以下为本地提示：最近数据已接收，建议重点关注 pH、COD、TDS 的连续波动趋势。',
      sampleCount: latestData.length,
      model: 'local-fallback',
      rawData: latestData
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

  return {
    message: response.data?.choices?.[0]?.message?.content || 'DeepSeek 未返回有效分析结果。',
    sampleCount: latestData.length,
    model: config.deepseek.model,
    rawData: latestData
  };
}

module.exports = {
  analyzeLatestWaterQuality
};
