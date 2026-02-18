const REFRESH_INTERVAL_MS = 3000;
let loadingDevices = false;

function formatDisplayTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

async function loadDevices() {
  if (loadingDevices) {
    return;
  }
  loadingDevices = true;

  try {
    const response = await fetch('/api/devices');
    const result = await response.json();
    const rows = result.data || [];

    const tbody = document.getElementById('deviceTable');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">暂无设备状态</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((item) => {
      const badgeClass = item.status === 'online' ? 'badge-online' : 'badge-offline';
      return `
        <tr>
          <td>${item.device_id}</td>
          <td><span class="${badgeClass}">${item.status}</span></td>
          <td>${item.runtime_seconds ?? 0}</td>
          <td>${formatDisplayTime(item.last_seen)}</td>
          <td>${formatDisplayTime(item.updated_at)}</td>
        </tr>
      `;
    }).join('');
  } finally {
    loadingDevices = false;
  }
}

document.getElementById('refreshBtn').addEventListener('click', loadDevices);
loadDevices();
setInterval(() => {
  if (document.hidden) {
    return;
  }
  loadDevices();
}, REFRESH_INTERVAL_MS);
