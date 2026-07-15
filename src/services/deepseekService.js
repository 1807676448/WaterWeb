const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config');
const { latestWaterQuality } = require('./deviceService');
const { run, get } = require('../db');

const execFileAsync = promisify(execFile);

// Retry transient upstream/network issues to reduce random ECONNRESET failures.
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'ENETRESET',
  'EAI_AGAIN'
]);
const REQUEST_TIMEOUT_MS = 120000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusFromError(error) {
  return Number(error?.status || error?.response?.status || 0);
}

function shouldRetryDeepseekRequest(error) {
  const code = String(error?.code || '').toUpperCase();
  const status = statusFromError(error);
  const message = String(error?.message || '').toLowerCase();

  if (status === 429 || status >= 500) {
    return true;
  }
  if (RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }
  return (
    message.includes('aborted')
    || message.includes('socket hang up')
    || message.includes('terminated')
    || message.includes('network')
  );
}

function buildRequestBody(prompt) {
  const now = new Date();
  // 东八区北京时间
  const beijingOffset = 8 * 60 * 60 * 1000;
  const beijingTime = new Date(now.getTime() + beijingOffset);
  const currentDateStr = beijingTime.toISOString().replace('T', ' ').slice(0, 19);

  return {
    model: config.deepseek.model || 'deepseek-v4-flash',
    messages: [
      {
        role: 'system',
        content: `你是一个专业的水质分析专家。当前北京时间是 ${currentDateStr} (UTC+8)。请根据提供的传感器数据（TDS、COD、TOC、pH、温度、浊度等）输出中文 Markdown 报告，包含趋势、异常、原因和建议。报告生成时间使用北京时间，数据采集时间以数据中的实际时间戳换算为北京时间，不要编造日期。`
      },
      {
        role: 'user',
        content: `以下是最近的水质检测数据，请分析健康状况并给出建议：\n${JSON.stringify(prompt, null, 2)}`
      }
    ],
    temperature: 0.3,
    max_tokens: 2048,
    thinking: { type: 'disabled' }
  };
}

async function requestWithFetch(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.deepseek.apiKey}`.trim(),
      'Content-Type': 'application/json',
      // Keep response simple on Node 18 to reduce stream abort risk.
      'Accept-Encoding': 'identity'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
    error.status = response.status;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const parseError = new Error(`DeepSeek 响应不是合法 JSON: ${text.slice(0, 160)}`);
    parseError.code = 'INVALID_JSON';
    throw parseError;
  }

  return { data: parsed };
}

async function requestWithCurl(url, body) {
  const timeoutSec = Math.ceil(REQUEST_TIMEOUT_MS / 1000);
  const args = [
    '-sS',
    '--connect-timeout',
    '10',
    '--max-time',
    String(timeoutSec),
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '-H',
    `Authorization: Bearer ${String(config.deepseek.apiKey || '').trim()}`,
    '--data',
    JSON.stringify(body),
    '-w',
    '\n%{http_code}',
    url
  ];

  const { stdout, stderr } = await execFileAsync('curl', args, {
    timeout: REQUEST_TIMEOUT_MS + 5000,
    maxBuffer: 1024 * 1024 * 5
  });

  if (stderr && stderr.trim()) {
    console.warn(`[deepseek] curl stderr: ${stderr.trim()}`);
  }

  const normalized = String(stdout || '');
  const cutIndex = normalized.lastIndexOf('\n');
  const bodyText = cutIndex >= 0 ? normalized.slice(0, cutIndex) : normalized;
  const statusText = cutIndex >= 0 ? normalized.slice(cutIndex + 1).trim() : '';
  const status = Number(statusText || 0);

  if (!status || status >= 400) {
    const error = new Error(`curl HTTP ${status || 'N/A'}: ${bodyText.slice(0, 400)}`);
    error.status = status || 0;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    const parseError = new Error(`curl 返回非 JSON: ${bodyText.slice(0, 160)}`);
    parseError.code = 'INVALID_JSON';
    throw parseError;
  }

  return { data: parsed };
}

async function requestDeepseekWithRetry(prompt) {
  const totalAttempts = MAX_RETRIES + 1;
  const url = `${config.deepseek.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const requestBody = buildRequestBody(prompt);

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      console.log(`[deepseek] request attempt=${attempt}/${totalAttempts} via fetch`);
      return await requestWithFetch(url, requestBody);
    } catch (fetchError) {
      const code = String(fetchError?.code || 'FETCH_ERROR');
      const status = statusFromError(fetchError) || 'N/A';
      const message = String(fetchError?.message || 'unknown');
      console.warn(`[deepseek] fetch failed attempt=${attempt}/${totalAttempts} code=${code} status=${status} message=${message}`);

      try {
        console.log(`[deepseek] request attempt=${attempt}/${totalAttempts} fallback=curl`);
        return await requestWithCurl(url, requestBody);
      } catch (curlError) {
        const curlCode = String(curlError?.code || 'CURL_ERROR');
        const curlStatus = statusFromError(curlError) || 'N/A';
        const curlMessage = String(curlError?.message || 'unknown');
        const hasNextAttempt = attempt < totalAttempts;
        const retryable = shouldRetryDeepseekRequest(curlError);

        console.warn(
          `[deepseek] curl failed attempt=${attempt}/${totalAttempts} code=${curlCode} status=${curlStatus} message=${curlMessage}`
        );

        if (!retryable || !hasNextAttempt) {
          throw curlError;
        }

        const delayMs = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
        await sleep(delayMs);
      }
    }
  }

  throw new Error('DeepSeek request failed without a concrete error');
}

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

// ──────────────────────────────────────────────
// 嵌入式设备 dshelp 专用：构建请求体
// ──────────────────────────────────────────────
function buildEmbeddedRequestBody(dataSummary) {
  const now = new Date();
  const beijingOffset = 8 * 60 * 60 * 1000;
  const beijingTime = new Date(now.getTime() + beijingOffset);
  const currentDateStr = beijingTime.toISOString().replace('T', ' ').slice(0, 19);

  return {
    model: config.deepseek.model || 'deepseek-v4-flash',
    messages: [
      {
        role: 'system',
        content: [
          '你是水质分析助手。严格按以下格式输出，总字数不超过80个汉字。',
          '',
          '格式要求：',
          '【水质概况】一句话概括整体水质，约15字。',
          '【关键指标】列出2-3个核心指标及数值，约25字。',
          '【建议】给出1条最核心建议，约15字。',
          '其余字数用于补充。',
          '',
          '硬性约束：',
          '1. 只能使用常用汉字、阿拉伯数字、中文标点（，。！？）、℃和%。',
          '2. 禁止使用英文、拼音、Markdown、HTML、特殊符号（如*#`~）。',
          '3. 数字后不带单位汉字时使用中文缩写（如"毫克每升"写作"mg/L"是禁止的，应写"123"即可）。',
          '4. 如果数据不足或无明显异常，如实简短说明，不要编造。',
          '5. 当前北京时间: ' + currentDateStr + '（仅用于判断数据时效，不要输出到分析中）。'
        ].join('\n')
      },
      {
        role: 'user',
        content: '以下为最近5次水质监测数据，请按要求输出分析：\n' + dataSummary
      }
    ],
    temperature: 0.2,
    max_tokens: 256,
    thinking: { type: 'disabled' }
  };
}

// ──────────────────────────────────────────────
// 清洗 AI 返回文本，适配嵌入式显示
// ──────────────────────────────────────────────
function sanitizeEmbeddedAnalysis(rawText) {
  if (!rawText) return '';

  let text = String(rawText);

  // 去掉 Markdown 标记
  text = text.replace(/[*#`~_>|]/g, '');
  // 去掉 HTML 标签
  text = text.replace(/<[^>]*>/g, '');
  // 去掉多余空白
  text = text.replace(/\s+/g, ' ').trim();
  // 去掉英文单词（保留数字和中文标点）
  // 去掉可能残留的英文及拼音（保留中文、数字、常用标点、℃%）
  text = text.replace(/[^\u4e00-\u9fff\u3000-\u303f\uff00-\uffefa-zA-Z0-9，。！？、：；℃％%.\-+ ]/g, '');
  // 压缩多余空格
  text = text.replace(/ {2,}/g, ' ').trim();

  // 按汉字计数截断到约80字
  let charCount = 0;
  let result = '';
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      charCount += 1;
    }
    result += ch;
    if (charCount >= 80) break;
  }

  return result;
}

// ──────────────────────────────────────────────
// 嵌入式设备分析：取最近5条数据 + DeepSeek 精简输出
// ──────────────────────────────────────────────
async function analyzeForEmbedded(deviceId) {
  const latestData = await latestWaterQuality(deviceId, 5);

  if (!latestData.length) {
    return {
      ok: false,
      analysis: '暂无水质数据，请先上报数据。',
      sample_count: 0
    };
  }

  if (!config.deepseek.apiKey) {
    return {
      ok: false,
      analysis: '未配置AI密钥，请联系管理员。',
      sample_count: latestData.length
    };
  }

  // 构建精简的数据摘要供 AI 分析
  const dataSummary = latestData
    .map((row, idx) => {
      const time = (row.created_at || '').slice(0, 19);
      return [
        `#${idx + 1} ${time}`,
        `TDS=${row.tds ?? '-'} COD=${row.cod ?? '-'} TOC=${row.toc ?? '-'}`,
        `pH=${row.ph ?? '-'} 水温=${row.tem ?? '-'} 浊度=${row.tur ?? '-'}`,
        `气温=${row.air_temp ?? '-'} 湿度=${row.air_hum ?? '-'}`
      ].join(' | ');
    })
    .join('\n');

  const url = `${config.deepseek.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const requestBody = buildEmbeddedRequestBody(dataSummary);

  // 简化的两路重试（fetch → curl）
  let response;
  try {
    console.log('[deepseek:dshelp] request via fetch');
    response = await requestWithFetch(url, requestBody);
  } catch (fetchError) {
    console.warn('[deepseek:dshelp] fetch failed, fallback curl:', fetchError.message);
    try {
      response = await requestWithCurl(url, requestBody);
    } catch (curlError) {
      console.error('[deepseek:dshelp] curl also failed:', curlError.message);
      return {
        ok: false,
        analysis: 'AI服务暂时不可用，请稍后重试。',
        sample_count: latestData.length
      };
    }
  }

  const rawMessage = response.data?.choices?.[0]?.message?.content || '';
  const analysis = sanitizeEmbeddedAnalysis(rawMessage);

  // 入库记录
  await saveAnalysisReport({
    deviceId,
    model: config.deepseek.model,
    sampleCount: latestData.length,
    message: analysis,
    rawData: latestData
  });

  return {
    ok: true,
    analysis,
    sample_count: latestData.length,
    device_id: deviceId || ''
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

  const response = await requestDeepseekWithRetry(prompt);

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
  latestAnalysisReport,
  analyzeForEmbedded
};
