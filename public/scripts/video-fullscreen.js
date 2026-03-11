let fsCurrentPeer = null;
let fsPollTimer = null;

function fsSetStatus(text, isError = false) {
  const el = document.getElementById('fsVideoStatus');
  el.textContent = text;
  el.className = isError ? 'fullscreen-status fullscreen-status-error' : 'fullscreen-status';
}

function fsGetQueryDefaults() {
  const params = new URLSearchParams(window.location.search);
  return {
    stream: params.get('stream') || '',
    mode: params.get('mode') || 'webrtc'
  };
}

async function fsFetchStreams() {
  const response = await fetch('/api/video/streams?limit=100');
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }
  return Array.isArray(result.data) ? result.data : [];
}

function fsWaitIceGatheringComplete(peer) {
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

async function fsPlayByWebRTC(playback, videoEl) {
  const peer = new RTCPeerConnection({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
  });
  fsCurrentPeer = peer;

  peer.addTransceiver('video', { direction: 'recvonly' });
  peer.ontrack = (event) => {
    videoEl.srcObject = event.streams[0];
  };

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await fsWaitIceGatheringComplete(peer);

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

function fsStopPlayback() {
  const videoEl = document.getElementById('fsVideoPlayer');
  if (fsCurrentPeer) {
    fsCurrentPeer.close();
    fsCurrentPeer = null;
  }
  videoEl.pause();
  videoEl.removeAttribute('src');
  videoEl.srcObject = null;
}

async function fsStartPlayback() {
  fsStopPlayback();

  const selected = document.getElementById('fsVideoStreamSelect').value;
  const mode = document.getElementById('fsVideoModeSelect').value;
  if (!selected) {
    fsSetStatus('请先选择视频流。', true);
    return;
  }

  const streams = await fsFetchStreams();
  const target = streams.find((item) => item.stream_name === selected);
  if (!target) {
    fsSetStatus('目标流不存在，请刷新。', true);
    return;
  }

  const videoEl = document.getElementById('fsVideoPlayer');
  try {
    if (mode === 'webrtc') {
      fsSetStatus('WebRTC 协商中...');
      try {
        await fsPlayByWebRTC(target.playback, videoEl);
        fsSetStatus(`播放中（WebRTC）：${target.stream_name}`);
        return;
      } catch (webrtcError) {
        fsSetStatus(`WebRTC 失败，尝试 HLS 回退：${webrtcError.message}`, true);
        videoEl.srcObject = null;
        videoEl.src = target.playback.hls_url;
        await videoEl.play();
        fsSetStatus(`播放中（HLS 回退）：${target.stream_name}`);
        return;
      }
    }

    videoEl.srcObject = null;
    videoEl.src = target.playback.hls_url;
    await videoEl.play();
    fsSetStatus(`播放中（HLS）：${target.stream_name}`);
  } catch (error) {
    fsSetStatus(`播放失败：${error.message}`, true);
  }
}

async function fsRefreshOptions() {
  const defaults = fsGetQueryDefaults();
  const select = document.getElementById('fsVideoStreamSelect');
  const previous = select.value;

  const streams = await fsFetchStreams();
  if (!streams.length) {
    select.innerHTML = '<option value="">暂无视频流</option>';
    fsSetStatus('暂无视频流，请等待设备推流。', true);
    return;
  }

  select.innerHTML = streams
    .map((stream) => `<option value="${stream.stream_name}">${stream.device_id} (${stream.stream_name}) [${stream.status}]</option>`)
    .join('');

  if (defaults.stream && streams.some((item) => item.stream_name === defaults.stream)) {
    select.value = defaults.stream;
  }

  if (previous && streams.some((item) => item.stream_name === previous)) {
    select.value = previous;
  }

  if (!select.value && streams.length) {
    select.value = streams[0].stream_name;
  }
}

async function initFullscreen() {
  const defaults = fsGetQueryDefaults();
  document.getElementById('fsVideoModeSelect').value = defaults.mode === 'hls' ? 'hls' : 'webrtc';

  try {
    await fsRefreshOptions();
    await fsStartPlayback();
  } catch (error) {
    fsSetStatus(`初始化失败：${error.message}`, true);
  }

  document.getElementById('fsRefreshBtn').addEventListener('click', async () => {
    try {
      await fsRefreshOptions();
    } catch (error) {
      fsSetStatus(`刷新失败：${error.message}`, true);
    }
  });

  document.getElementById('fsPlayBtn').addEventListener('click', fsStartPlayback);

  fsPollTimer = setInterval(async () => {
    if (document.hidden) {
      return;
    }

    try {
      await fsRefreshOptions();
    } catch (error) {
      fsSetStatus(`自动刷新失败：${error.message}`, true);
    }
  }, 5000);
}

window.addEventListener('beforeunload', () => {
  if (fsPollTimer) {
    clearInterval(fsPollTimer);
    fsPollTimer = null;
  }
  fsStopPlayback();
});

initFullscreen();
