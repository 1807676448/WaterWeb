function renderMarkdown(markdownText) {
  const resultEl = document.getElementById('result');
  const rawText = markdownText || '暂无分析内容';

  let html;
  if (window.marked && typeof window.marked.parse === 'function') {
    html = window.marked.parse(rawText);
  } else {
    const escaped = rawText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    html = `<p>${escaped}</p>`;
  }

  if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
    resultEl.innerHTML = window.DOMPurify.sanitize(html);
    return;
  }

  resultEl.innerHTML = html;
}

function renderMeta(report) {
  const metaEl = document.getElementById('analysisMeta');
  if (!report) {
    metaEl.textContent = '暂无历史分析';
    return;
  }

  const createdAt = report.created_at ? new Date(report.created_at).toLocaleString('zh-CN', { hour12: false }) : '--';
  metaEl.textContent = `最近分析时间：${createdAt} ｜ 模型：${report.model || '--'} ｜ 样本数：${report.sampleCount ?? '--'} ｜ 设备：${report.device_id || '全部设备'}`;
}

async function loadLatestAnalysis() {
  const resultEl = document.getElementById('result');
  const deviceId = document.getElementById('deviceId').value.trim();
  const query = new URLSearchParams();
  if (deviceId) {
    query.set('device_id', deviceId);
  }

  try {
    const response = await fetch(`/api/analysis/deepseek/latest?${query.toString()}`);
    const result = await response.json();
    if (!response.ok) {
      renderMeta(null);
      resultEl.textContent = result.error || '加载历史失败';
      return;
    }

    const report = result.data;
    renderMeta(report);
    if (!report) {
      resultEl.textContent = '暂无历史分析，点击“请求 DeepSeek 分析”生成结果。';
      return;
    }

    renderMarkdown(report.message || '暂无分析内容');
  } catch (error) {
    renderMeta(null);
    resultEl.textContent = `请求异常: ${error.message}`;
  }
}

async function analyze() {
  const button = document.getElementById('analyzeBtn');
  const resultEl = document.getElementById('result');
  const deviceId = document.getElementById('deviceId').value.trim();

  button.disabled = true;
  resultEl.textContent = '分析中，请稍候...';

  try {
    const response = await fetch('/api/analysis/deepseek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId || undefined })
    });

    const result = await response.json();
    if (!response.ok) {
      resultEl.textContent = result.error || '分析失败';
      return;
    }

    renderMeta({
      created_at: new Date().toISOString(),
      model: result.model,
      sampleCount: result.sampleCount,
      device_id: deviceId || ''
    });
    renderMarkdown(result.message || '分析结果为空');
  } catch (error) {
    resultEl.textContent = `请求异常: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

document.getElementById('analyzeBtn').addEventListener('click', analyze);
document.getElementById('loadLatestBtn').addEventListener('click', loadLatestAnalysis);
document.getElementById('deviceId').addEventListener('change', loadLatestAnalysis);
loadLatestAnalysis();
