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

    resultEl.textContent = `模型: ${result.model}\n样本数: ${result.sampleCount}\n\n${result.message}`;
  } catch (error) {
    resultEl.textContent = `请求异常: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

document.getElementById('analyzeBtn').addEventListener('click', analyze);
