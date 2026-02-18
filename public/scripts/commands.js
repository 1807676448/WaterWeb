const REFRESH_INTERVAL_MS = 3000;
let loading = false;

function formatDisplayTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prettyJson(text) {
  if (!text) return '--';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (error) {
    return text;
  }
}

function statusBadge(status) {
  if (status === 'success') {
    return '<span class="badge-success">成功</span>';
  }
  return '<span class="badge-failed">失败</span>';
}

async function loadDeviceOptions() {
  const select = document.getElementById('deviceId');
  const response = await fetch('/api/devices');
  const result = await response.json();
  const rows = Array.isArray(result.data) ? result.data : [];

  const seen = new Set();
  rows.forEach((row) => {
    const id = String(row.device_id || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    select.appendChild(option);
  });
}

async function loadCommands() {
  if (loading) return;
  loading = true;

  try {
    const deviceId = document.getElementById('deviceId').value.trim();
    const limit = document.getElementById('limit').value;

    const query = new URLSearchParams();
    if (deviceId) query.set('device_id', deviceId);
    query.set('limit', limit);

    const response = await fetch(`/api/commands?${query.toString()}`);
    const result = await response.json();
    const rows = result.data || [];

    const tbody = document.getElementById('commandTable');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">暂无指令记录</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((item) => `
      <tr>
        <td>${formatDisplayTime(item.created_at)}</td>
        <td>${escapeHtml(item.device_id || '--')}</td>
        <td>${escapeHtml(item.command || '--')}</td>
        <td>${statusBadge(item.execution_status)}</td>
        <td><details><summary>查看</summary><pre class="json-cell">${escapeHtml(prettyJson(item.request_json))}</pre></details></td>
        <td><details><summary>查看</summary><pre class="json-cell">${escapeHtml(prettyJson(item.response_json))}</pre></details></td>
      </tr>
    `).join('');
  } finally {
    loading = false;
  }
}

document.getElementById('refreshBtn').addEventListener('click', loadCommands);
document.getElementById('deviceId').addEventListener('change', loadCommands);
document.getElementById('limit').addEventListener('change', loadCommands);

async function initPage() {
  await loadDeviceOptions();
  await loadCommands();

  setInterval(() => {
    if (document.hidden) return;
    loadCommands();
  }, REFRESH_INTERVAL_MS);
}

initPage();
