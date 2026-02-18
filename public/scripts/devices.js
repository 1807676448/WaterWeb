async function loadDevices() {
  const response = await fetch('/api/devices');
  const result = await response.json();
  const rows = result.data || [];

  const tbody = document.getElementById('deviceTable');
  tbody.innerHTML = rows.map((item) => {
    const badgeClass = item.status === 'online' ? 'badge-online' : 'badge-offline';
    return `
      <tr>
        <td>${item.device_id}</td>
        <td><span class="${badgeClass}">${item.status}</span></td>
        <td>${item.runtime_seconds ?? 0}</td>
        <td>${item.last_seen ?? ''}</td>
        <td>${item.updated_at ?? ''}</td>
      </tr>
    `;
  }).join('');
}

document.getElementById('refreshBtn').addEventListener('click', loadDevices);
loadDevices();
