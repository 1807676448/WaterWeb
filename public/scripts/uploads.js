function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDisplayTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function setMessage(text, isError = false) {
  const msgEl = document.getElementById('uploadMsg');
  msgEl.textContent = text;
  msgEl.className = isError ? 'upload-msg upload-msg-error' : 'upload-msg upload-msg-ok';
}

let previewObjectUrl = '';

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function clearPreview() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = '';
  }
  const previewEl = document.getElementById('uploadPreview');
  previewEl.className = 'upload-preview upload-preview-empty';
  previewEl.textContent = '请选择图片后预览';
}

function renderPreview(file) {
  if (!file) {
    clearPreview();
    return;
  }

  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
  }

  previewObjectUrl = URL.createObjectURL(file);
  const previewEl = document.getElementById('uploadPreview');
  previewEl.className = 'upload-preview';
  previewEl.innerHTML = `
    <img src="${previewObjectUrl}" alt="preview" />
    <div class="upload-preview-meta">文件：${escapeHtml(file.name)} ｜ 大小：${formatFileSize(file.size)}</div>
  `;
}

function renderList(rows) {
  const listEl = document.getElementById('uploadList');
  if (!rows.length) {
    listEl.innerHTML = '<div class="upload-empty">暂无图片提交记录</div>';
    return;
  }

  listEl.innerHTML = rows.map((item) => `
    <article class="upload-item">
      <img
        class="js-upload-zoom"
        src="${escapeHtml(item.public_url)}"
        alt="${escapeHtml(item.file_name || 'upload-image')}"
        data-full-url="${escapeHtml(item.public_url)}"
        loading="lazy"
      />
      <div class="upload-item-content">
        <div class="upload-item-title">${escapeHtml(item.file_name || '--')}</div>
        <div class="upload-item-desc">${escapeHtml(item.description || '（无说明）')}</div>
        <div class="upload-item-meta">时间：${escapeHtml(formatDisplayTime(item.created_at))} ｜ 大小：${item.file_size || 0} B</div>
      </div>
    </article>
  `).join('');
}

function openZoomModal(url, altText) {
  const modal = document.getElementById('imageZoomModal');
  const image = document.getElementById('imageZoomTarget');

  image.src = url;
  image.alt = altText || 'zoom-preview';
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeZoomModal() {
  const modal = document.getElementById('imageZoomModal');
  const image = document.getElementById('imageZoomTarget');

  image.src = '';
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

async function loadRecentUploads() {
  try {
    const response = await fetch('/api/uploads/recent');
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    renderList(Array.isArray(result.data) ? result.data : []);
  } catch (error) {
    setMessage(`加载失败：${error.message}`, true);
  }
}

async function submitUpload() {
  const fileInput = document.getElementById('imageFile');
  const descInput = document.getElementById('imageDesc');
  const tokenInput = document.getElementById('uploadToken');
  const button = document.getElementById('uploadBtn');

  const file = fileInput.files?.[0];
  if (!file) {
    setMessage('请选择图片文件', true);
    return;
  }

  const formData = new FormData();
  formData.append('image', file);
  formData.append('description', String(descInput.value || '').trim());

  button.disabled = true;
  setMessage('上传中...');

  try {
    const headers = {};
    const token = String(tokenInput.value || '').trim();
    if (token) {
      headers['X-Upload-Token'] = token;
    }

    const response = await fetch('/api/uploads', {
      method: 'POST',
      headers,
      body: formData
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    setMessage('上传成功');
    fileInput.value = '';
    descInput.value = '';
    clearPreview();
    await loadRecentUploads();
  } catch (error) {
    setMessage(`上传失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

document.getElementById('imageFile').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  renderPreview(file);
});

document.getElementById('uploadList').addEventListener('click', (event) => {
  const target = event.target.closest('.js-upload-zoom');
  if (!target) {
    return;
  }

  const fullUrl = target.getAttribute('data-full-url') || target.getAttribute('src') || '';
  if (!fullUrl) {
    return;
  }

  openZoomModal(fullUrl, target.getAttribute('alt') || 'zoom-preview');
});

document.getElementById('imageZoomClose').addEventListener('click', closeZoomModal);
document.getElementById('imageZoomBackdrop').addEventListener('click', closeZoomModal);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeZoomModal();
  }
});

document.getElementById('uploadBtn').addEventListener('click', submitUpload);
loadRecentUploads();
