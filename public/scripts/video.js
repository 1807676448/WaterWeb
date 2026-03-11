let currentPeer = null;
let pollTimer = null;
let currentHls = null;
let hlsScriptPromise = null;

const HLS_MIME = 'application/vnd.apple.mpegurl';
const HLS_SCRIPT_CANDIDATES = [
  '/vendor/hls.min.js',
  'https://cdn.bootcdn.net/ajax/libs/hls.js/1.5.18/hls.min.js',
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.18/dist/hls.min.js',
  'https://unpkg.com/hls.js@1.5.18/dist/hls.min.js'
];

function setStatus(text, isError = false) {
  const el = document.getElementById('videoStatus');
  el.textContent = text;
  el.className = isError ? 'video-status video-status-error' : 'video-status';
}

function setMeta(stream) {
  const el = document.getElementById('videoMeta');
  if (!stream) {
    el.textContent = '-';
    return;
  }

  const shape = stream.width && stream.height ? `${stream.width}x${stream.height}` : '--';
  const fps = stream.fps || '--';
  const bitrate = stream.bitrate_kbps ? `${stream.bitrate_kbps} kbps` : '--';
  const source = stream.source || '--';
  const state = stream.status || '--';
  el.textContent = `设备: ${stream.device_id} | 状态: ${state} | 编码: ${stream.codec || '--'} | 分辨率: ${shape} | FPS: ${fps} | 码率: ${bitrate} | 来源: ${source}`;
}

function getQueryDefaults() {
  const params = new URLSearchParams(window.location.search);
  return {
    stream: params.get('stream') || '',
    mode: params.get('mode') || 'webrtc'
  };
}

function canUseNativeHls(videoEl) {
  return !!videoEl.canPlayType(HLS_MIME);
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`加载脚本失败: ${url}`));
    document.head.appendChild(script);
  });
}

async function ensureHlsLibrary() {
  if (window.Hls) {
    return window.Hls;
  }

  if (!hlsScriptPromise) {
    hlsScriptPromise = (async () => {
      for (const url of HLS_SCRIPT_CANDIDATES) {
        try {
          await loadScript(url);
          if (window.Hls) {
            return window.Hls;
          }
        } catch (error) {
          // Try next source when current one is unavailable.
        }
      }

      throw new Error('当前浏览器不支持原生 HLS，且 hls.js 加载失败');
    })();
  }

  return hlsScriptPromise;
}

async function fetchStreams() {
  const response = await fetch('/api/video/streams?limit=100');
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }
  return Array.isArray(result.data) ? result.data : [];
}

function streamOptionLabel(stream) {
  return `${stream.device_id} (${stream.stream_name}) [${stream.status}]`;
}

async function refreshStreamOptions() {
  const select = document.getElementById('videoStreamSelect');
  const previous = select.value;
  const defaults = getQueryDefaults();

  const streams = await fetchStreams();
  if (!streams.length) {
    select.innerHTML = '<option value="">暂无在线流</option>';
    setMeta(null);
    setStatus('暂无视频流，请先推流后再刷新。', true);
    return [];
  }

  select.innerHTML = streams.map((stream) => (
    `<option value="${stream.stream_name}">${streamOptionLabel(stream)}</option>`
  )).join('');

  if (defaults.stream && streams.some((stream) => stream.stream_name === defaults.stream)) {
    select.value = defaults.stream;
  }

  if (previous && streams.some((stream) => stream.stream_name === previous)) {
    select.value = previous;
  }

  const selected = streams.find((stream) => stream.stream_name === select.value) || streams[0];
  if (selected) {
    setMeta(selected);
    setStatus(`已选中 ${selected.stream_name}`);
  }

  updateFullscreenLink();
  return streams;
}

function waitIceGatheringComplete(peer) {
  if (peer.iceGatheringState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    function checkState() {
      if (peer.iceGatheringState === 'complete') {
        peer.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    }

    peer.addEventListener('icegatheringstatechange', checkState);
    setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', checkState);
      resolve();
    }, 4000);
  });
}

async function playByWebRTC(playback, videoEl) {
  if (!playback || !playback.webrtc_whep_url) {
    throw new Error('缺少 WebRTC 播放地址');
  }

  const peer = new RTCPeerConnection({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
  });
  currentPeer = peer;

  peer.addTransceiver('video', { direction: 'recvonly' });
  peer.ontrack = (event) => {
    videoEl.srcObject = event.streams[0];
  };

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitIceGatheringComplete(peer);

  const response = await fetch(playback.webrtc_whep_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
      Accept: 'application/sdp'
    },
    body: peer.localDescription.sdp
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`WebRTC 协商失败 HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }

  const answerSdp = await response.text();
  await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
}

async function playByHls(playback, videoEl) {
  if (!playback || !playback.hls_url) {
    throw new Error('缺少 HLS 播放地址');
  }

  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }

  videoEl.srcObject = null;

  if (canUseNativeHls(videoEl)) {
    videoEl.src = playback.hls_url;
    return videoEl.play();
  }

  const Hls = await ensureHlsLibrary();
  if (!Hls || !Hls.isSupported()) {
    throw new Error('当前浏览器不支持 HLS（可尝试 WebRTC 或更换浏览器）');
  }

  currentHls = new Hls({
    enableWorker: true,
    lowLatencyMode: true,
    backBufferLength: 30
  });
  currentHls.loadSource(playback.hls_url);
  currentHls.attachMedia(videoEl);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('HLS 首帧超时，请检查流状态'));
    }, 8000);

    function clearAndResolve() {
      clearTimeout(timeout);
      resolve();
    }

    function onError(event, data) {
      if (data && data.fatal) {
        clearTimeout(timeout);
        reject(new Error(`HLS 错误: ${data.type || 'unknown'}/${data.details || 'unknown'}`));
      }
    }

    currentHls.once(Hls.Events.MANIFEST_PARSED, clearAndResolve);
    currentHls.on(Hls.Events.ERROR, onError);
  });

  return videoEl.play();
}

function stopPlayback() {
  const videoEl = document.getElementById('videoPlayer');
  if (currentPeer) {
    currentPeer.close();
    currentPeer = null;
  }
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }
  videoEl.pause();
  videoEl.removeAttribute('src');
  videoEl.srcObject = null;
}

async function startPlayback() {
  stopPlayback();

  const mode = document.getElementById('videoModeSelect').value;
  const selectedStreamName = document.getElementById('videoStreamSelect').value;
  if (!selectedStreamName) {
    setStatus('请先选择视频流。', true);
    return;
  }

  const streams = await fetchStreams();
  const selected = streams.find((item) => item.stream_name === selectedStreamName);
  if (!selected) {
    setStatus('所选流已不存在，请刷新。', true);
    return;
  }

  setMeta(selected);

  const videoEl = document.getElementById('videoPlayer');
  try {
    if (mode === 'webrtc') {
      setStatus('WebRTC 协商中...');
      try {
        await playByWebRTC(selected.playback, videoEl);
        setStatus(`播放中（WebRTC）：${selected.stream_name}`);
        return;
      } catch (webrtcError) {
        setStatus(`WebRTC 失败，尝试 HLS 回退：${webrtcError.message}`, true);
        await playByHls(selected.playback, videoEl);
        setStatus(`播放中（HLS 回退）：${selected.stream_name}`);
        return;
      }
    }

    setStatus('加载 HLS 中...');
    await playByHls(selected.playback, videoEl);
    setStatus(`播放中（HLS）：${selected.stream_name}`);
  } catch (error) {
    setStatus(`播放失败：${error.message}`, true);
  }
}

function updateFullscreenLink() {
  const streamName = document.getElementById('videoStreamSelect').value;
  const mode = document.getElementById('videoModeSelect').value;
  const link = document.getElementById('videoFullscreenLink');

  const query = new URLSearchParams();
  if (streamName) {
    query.set('stream', streamName);
  }
  query.set('mode', mode);

  link.href = `/video-fullscreen.html?${query.toString()}`;
}

async function init() {
  const defaults = getQueryDefaults();
  document.getElementById('videoModeSelect').value = defaults.mode === 'hls' ? 'hls' : 'webrtc';

  try {
    await refreshStreamOptions();
  } catch (error) {
    setStatus(`加载流列表失败：${error.message}`, true);
  }

  document.getElementById('videoRefreshBtn').addEventListener('click', async () => {
    try {
      await refreshStreamOptions();
    } catch (error) {
      setStatus(`刷新失败：${error.message}`, true);
    }
  });

  document.getElementById('videoPlayBtn').addEventListener('click', startPlayback);
  document.getElementById('videoModeSelect').addEventListener('change', updateFullscreenLink);

  document.getElementById('videoStreamSelect').addEventListener('change', async () => {
    updateFullscreenLink();
    try {
      const streams = await fetchStreams();
      const selected = streams.find((item) => item.stream_name === document.getElementById('videoStreamSelect').value);
      setMeta(selected || null);
    } catch (error) {
      setStatus(`加载流信息失败：${error.message}`, true);
    }
  });

  pollTimer = setInterval(async () => {
    if (document.hidden) {
      return;
    }
    try {
      await refreshStreamOptions();
    } catch (error) {
      setStatus(`自动刷新失败：${error.message}`, true);
    }
  }, 5000);
}

window.addEventListener('beforeunload', () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopPlayback();
});

init();
