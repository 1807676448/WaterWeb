let chart;
const REFRESH_INTERVAL_MS = 3000;
let querying = false;

const METRIC_FIELDS = [
  { key: 'tds', label: '总溶解固体 TDS', digits: 2, color: '#2563eb' },
  { key: 'cod', label: '化学需氧量 COD', digits: 2, color: '#10b981' },
  { key: 'toc', label: '总有机碳 TOC', digits: 2, color: '#f59e0b' },
  { key: 'uv254', label: '紫外吸收 UV254', digits: 4, color: '#a855f7' },
  { key: 'ph', label: '酸碱度 pH', digits: 2, color: '#0ea5e9' },
  { key: 'tem', label: '水温 Tem', digits: 2, color: '#ef4444' },
  { key: 'tur', label: '浊度 Tur', digits: 2, color: '#f97316' },
  { key: 'air_temp', label: '气温', digits: 2, color: '#14b8a6' },
  { key: 'air_hum', label: '空气湿度', digits: 2, color: '#22c55e' },
  { key: 'pressure', label: '气压', digits: 2, color: '#6366f1' },
  { key: 'altitude', label: '海拔', digits: 2, color: '#ec4899' }
];

function formatDateTimeLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function initDefaultTimeRange() {
  const end = new Date(Date.now() + 60 * 1000);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  document.getElementById('startTime').value = formatDateTimeLocal(start);
  document.getElementById('endTime').value = formatDateTimeLocal(end);
}

function setQuickRange(hours) {
  const end = new Date(Date.now() + 60 * 1000);
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  document.getElementById('startTime').value = formatDateTimeLocal(start);
  document.getElementById('endTime').value = formatDateTimeLocal(end);
  queryData();
}

function isRealtimeMode() {
  return document.getElementById('realtimeMode').value === 'on';
}

function currentRealtimeEnd() {
  return new Date(Date.now() + 60 * 1000);
}

function syncRealtimeEndField() {
  if (!isRealtimeMode()) {
    document.getElementById('endTime').disabled = false;
    return;
  }

  const end = currentRealtimeEnd();
  document.getElementById('endTime').value = formatDateTimeLocal(end);
  document.getElementById('endTime').disabled = true;
}

async function loadDeviceOptions() {
  const select = document.getElementById('deviceId');
  const response = await fetch('/api/devices');
  const result = await response.json();
  const rows = Array.isArray(result.data) ? result.data : [];

  const seen = new Set();
  for (const row of rows) {
    const id = String(row.device_id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    select.appendChild(option);
  }
}

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
  const rangeEl = document.getElementById('summaryRange');
  const rangeText = rows.length
    ? `${formatDisplayTime(rows[rows.length - 1]?.created_at)} ~ ${formatDisplayTime(rows[0]?.created_at)}`
    : '--';
  rangeEl.textContent = `时间范围：${rangeText}`;

  const fixedCards = `
    <div class="stat-item overview-card">
      <span class="stat-label">样本总数</span>
      <strong class="stat-value">${rows.length}</strong>
    </div>
    <div class="stat-item overview-card">
      <span class="stat-label">设备数量</span>
      <strong class="stat-value">${new Set(rows.map((row) => row.device_id)).size}</strong>
    </div>
  `;

  const metricCards = METRIC_FIELDS.map((metric) => {
    const values = rows
      .map((row) => Number(row[metric.key]))
      .filter((value) => Number.isFinite(value));

    if (!values.length) {
      return `
        <div class="stat-item metric-card">
          <strong class="metric-title">${metric.label}</strong>
          <div class="metric-row metric-row-avg"><span>平均</span><strong class="metric-value metric-value-avg">--</strong></div>
          <div class="metric-row"><span>最大</span><strong class="metric-value">--</strong></div>
          <div class="metric-row"><span>最小</span><strong class="metric-value">--</strong></div>
        </div>
      `;
    }

    const sum = values.reduce((total, item) => total + item, 0);
    const avg = sum / values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);

    return `
      <div class="stat-item metric-card">
        <strong class="metric-title">${metric.label}</strong>
        <div class="metric-row metric-row-avg"><span>平均</span><strong class="metric-value metric-value-avg">${formatNum(avg, metric.digits)}</strong></div>
        <div class="metric-row"><span>最大</span><strong class="metric-value">${formatNum(max, metric.digits)}</strong></div>
        <div class="metric-row"><span>最小</span><strong class="metric-value">${formatNum(min, metric.digits)}</strong></div>
      </div>
    `;
  }).join('');

  wrap.innerHTML = fixedCards + metricCards;
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

  const orderedRows = [...rows].reverse();
  const labels = orderedRows.map((row) => formatDisplayTime(row.created_at));
  const datasets = METRIC_FIELDS.map((metric) => ({
    label: metric.label,
    data: orderedRows.map((row) => {
      const value = Number(row[metric.key]);
      return Number.isFinite(value) ? value : null;
    }),
    borderColor: metric.color,
    backgroundColor: metric.color,
    tension: 0.3,
    pointRadius: 1,
    fill: false,
    spanGaps: true
  }));

  if (chart) {
    chart.destroy();
  }

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top'
        }
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 10
          }
        }
      }
    }
  });
}

async function queryData() {
  if (querying) {
    return;
  }
  querying = true;

  const deviceId = document.getElementById('deviceId').value.trim();
  const start = formatDateForApi(document.getElementById('startTime').value);
  const endValue = isRealtimeMode()
    ? formatDateTimeLocal(currentRealtimeEnd())
    : document.getElementById('endTime').value;

  if (isRealtimeMode()) {
    document.getElementById('endTime').value = endValue;
  }

  const end = formatDateForApi(endValue);

  const query = new URLSearchParams();
  if (deviceId) query.set('device_id', deviceId);
  if (start) query.set('start', start);
  if (end) query.set('end', end);
  query.set('limit', '500');

  try {
    const response = await fetch(`/api/metrics?${query.toString()}`);
    const result = await response.json();
    const data = result.data || [];

    renderSummary(data);
    renderTable(data);
    renderChart(data);
  } finally {
    querying = false;
  }
}

document.getElementById('queryBtn').addEventListener('click', queryData);
document.getElementById('range1h').addEventListener('click', () => setQuickRange(1));
document.getElementById('range24h').addEventListener('click', () => setQuickRange(24));
document.getElementById('range7d').addEventListener('click', () => setQuickRange(24 * 7));
document.getElementById('realtimeMode').addEventListener('change', () => {
  syncRealtimeEndField();
  queryData();
});

async function initPage() {
  initDefaultTimeRange();
  syncRealtimeEndField();
  await loadDeviceOptions();
  await queryData();
  setInterval(() => {
    if (document.hidden) {
      return;
    }
    syncRealtimeEndField();
    queryData();
  }, REFRESH_INTERVAL_MS);
}

initPage();
