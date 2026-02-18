let chart;

function formatDateForApi(dateText) {
  if (!dateText) return '';
  return new Date(dateText).toISOString();
}

function renderTable(rows) {
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = rows.map((item) => `
    <tr>
      <td>${item.created_at}</td>
      <td>${item.device_id}</td>
      <td>${item.tds ?? ''}</td>
      <td>${item.cod ?? ''}</td>
      <td>${item.toc ?? ''}</td>
      <td>${item.uv254 ?? ''}</td>
      <td>${item.ph ?? ''}</td>
      <td>${item.tem ?? ''}</td>
    </tr>
  `).join('');
}

function renderChart(rows) {
  const labels = [...rows].reverse().map((row) => row.created_at);
  const phData = [...rows].reverse().map((row) => row.ph);
  const tdsData = [...rows].reverse().map((row) => row.tds);

  const ctx = document.getElementById('lineChart');

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
          fill: false
        },
        {
          label: 'TDS',
          data: tdsData,
          borderColor: '#10b981',
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false
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

  renderTable(data);
  renderChart(data);
}

document.getElementById('queryBtn').addEventListener('click', queryData);
queryData();
