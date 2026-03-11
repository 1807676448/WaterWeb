let currentPeer = null;
let pollTimer = null;

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
    }, 1500);
  });
}

async function playByWebRTC(playback, videoEl) {
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
    headers: { 'Content-Type': 'application/sdp' },
    body: peer.localDescription.sdp
  });

  if (!response.ok) {
    throw new Error(`WebRTC 协商失败 HTTP ${response.status}`);
  }

  const answerSdp = await response.text();
  await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
}

function playByHls(playback, videoEl) {
  videoEl.srcObject = null;
  videoEl.src = playback.hls_url;
  return videoEl.play();
}

function stopPlayback() {
  const videoEl = document.getElementById('videoPlayer');
  if (currentPeer) {
    currentPeer.close();
    currentPeer = null;
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
