let chart;

function formatDateForApi(dateText) {
  if (!dateText) return '';
  return new Date(dateText).toISOString();
}

function formatDisplayTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatNum(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '--';
  const num = Number(value);
  if (Number.isNaN(num)) return '--';
  return num.toFixed(digits);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseRawJson(rawText) {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch (error) {
    return null;
  }
}

function reportId(item) {
  const raw = parseRawJson(item.raw_json);
  return raw?.id ?? '--';
}

function renderRawJson(item) {
  if (!item.raw_json) return '--';
  const parsed = parseRawJson(item.raw_json);
  const text = parsed ? JSON.stringify(parsed, null, 2) : item.raw_json;
  return `<details><summary>查看</summary><pre class="json-cell">${escapeHtml(text)}</pre></details>`;
}

function renderSummary(rows) {
  const wrap = document.getElementById('summaryCards');
  if (!rows.length) {
    wrap.innerHTML = `
      <div class="stat-item">
        <span class="stat-label">样本总数</span>
        <strong class="stat-value">0</strong>
      </div>
      <div class="stat-item">
        <span class="stat-label">设备数量</span>
        <strong class="stat-value">0</strong>
      </div>
      <div class="stat-item">
        <span class="stat-label">平均 pH</span>
        <strong class="stat-value">--</strong>
      </div>
      <div class="stat-item">
        <span class="stat-label">最高 COD</span>
        <strong class="stat-value">--</strong>
      </div>
      <div class="stat-item">
        <span class="stat-label">平均 TDS</span>
        <strong class="stat-value">--</strong>
      </div>
      <div class="stat-item">
        <span class="stat-label">最新温度</span>
        <strong class="stat-value">--</strong>
      </div>
    `;
    return;
  }

  const deviceCount = new Set(rows.map((row) => row.device_id)).size;
  const avgPh = rows.reduce((sum, row) => sum + (Number(row.ph) || 0), 0) / rows.length;
  const avgTds = rows.reduce((sum, row) => sum + (Number(row.tds) || 0), 0) / rows.length;
  const maxCod = Math.max(...rows.map((row) => Number(row.cod) || 0));
  const latestTem = rows[0]?.tem;

  wrap.innerHTML = `
    <div class="stat-item">
      <span class="stat-label">样本总数</span>
      <strong class="stat-value">${rows.length}</strong>
    </div>
    <div class="stat-item">
      <span class="stat-label">设备数量</span>
      <strong class="stat-value">${deviceCount}</strong>
    </div>
    <div class="stat-item">
      <span class="stat-label">平均 pH</span>
      <strong class="stat-value">${formatNum(avgPh)}</strong>
    </div>
    <div class="stat-item">
      <span class="stat-label">最高 COD</span>
      <strong class="stat-value">${formatNum(maxCod)}</strong>
    </div>
    <div class="stat-item">
      <span class="stat-label">平均 TDS</span>
      <strong class="stat-value">${formatNum(avgTds)}</strong>
    </div>
    <div class="stat-item">
      <span class="stat-label">最新温度</span>
      <strong class="stat-value">${formatNum(latestTem)}</strong>
    </div>
  `;
}

function renderTable(rows) {
  const tbody = document.getElementById('tableBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="15" class="table-empty">暂无数据</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((item) => `
    <tr>
      <td>${formatDisplayTime(item.created_at)}</td>
      <td>${escapeHtml(item.device_id || '--')}</td>
      <td>${escapeHtml(reportId(item))}</td>
      <td>${formatNum(item.tds)}</td>
      <td>${formatNum(item.cod)}</td>
      <td>${formatNum(item.toc)}</td>
      <td>${formatNum(item.uv254, 4)}</td>
      <td>${formatNum(item.ph)}</td>
      <td>${formatNum(item.tem)}</td>
      <td>${formatNum(item.tur)}</td>
      <td>${formatNum(item.air_temp)}</td>
      <td>${formatNum(item.air_hum)}</td>
      <td>${formatNum(item.pressure)}</td>
      <td>${formatNum(item.altitude)}</td>
      <td>${renderRawJson(item)}</td>
    </tr>
  `).join('');
}

function renderChart(rows) {
  const ctx = document.getElementById('lineChart');
  if (!rows.length) {
    if (chart) {
      chart.destroy();
      chart = null;
    }
    return;
  }

  const labels = [...rows].reverse().map((row) => row.created_at);
  const phData = [...rows].reverse().map((row) => row.ph);
  const tdsData = [...rows].reverse().map((row) => row.tds);
  const codData = [...rows].reverse().map((row) => row.cod);
  const temData = [...rows].reverse().map((row) => row.tem);

  if (chart) {
    chart.destroy();
  }

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'pH',
          data: phData,
          borderColor: '#2563eb',
          tension: 0.35,
          fill: false
        },
        {
          label: 'TDS',
          data: tdsData,
          borderColor: '#10b981',
          tension: 0.35,
          fill: false
        },
        {
          label: 'COD',
          data: codData,
          borderColor: '#f59e0b',
          tension: 0.35,
          fill: false
        },
        {
          label: 'Tem',
          data: temData,
          borderColor: '#ef4444',
          tension: 0.35,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top'
        }
      }
    }
  });
}

async function queryData() {
  const deviceId = document.getElementById('deviceId').value.trim();
  const start = formatDateForApi(document.getElementById('startTime').value);
  const end = formatDateForApi(document.getElementById('endTime').value);

  const query = new URLSearchParams();
  if (deviceId) query.set('device_id', deviceId);
  if (start) query.set('start', start);
  if (end) query.set('end', end);
  query.set('limit', '500');

  const response = await fetch(`/api/metrics?${query.toString()}`);
  const result = await response.json();
  const data = result.data || [];

  renderSummary(data);
  renderTable(data);
  renderChart(data);
}

document.getElementById('queryBtn').addEventListener('click', queryData);
queryData();
