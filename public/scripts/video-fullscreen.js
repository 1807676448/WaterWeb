let fsCurrentPeer = null;
let fsPollTimer = null;
let fsCurrentHls = null;
let fsHlsScriptPromise = null;

const FS_HLS_MIME = 'application/vnd.apple.mpegurl';
const FS_HLS_SCRIPT_CANDIDATES = [
  '/vendor/hls.min.js',
  'https://cdn.bootcdn.net/ajax/libs/hls.js/1.5.18/hls.min.js',
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.18/dist/hls.min.js',
  'https://unpkg.com/hls.js@1.5.18/dist/hls.min.js'
];

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

function fsCanUseNativeHls(videoEl) {
  return !!videoEl.canPlayType(FS_HLS_MIME);
}

function fsLoadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`加载脚本失败: ${url}`));
    document.head.appendChild(script);
  });
}

async function fsEnsureHlsLibrary() {
  if (window.Hls) {
    return window.Hls;
  }

  if (!fsHlsScriptPromise) {
    fsHlsScriptPromise = (async () => {
      for (const url of FS_HLS_SCRIPT_CANDIDATES) {
        try {
          await fsLoadScript(url);
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

  return fsHlsScriptPromise;
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
    }, 4000);
  });
}

async function fsPlayByWebRTC(playback, videoEl) {
  if (!playback || !playback.webrtc_whep_url) {
    throw new Error('缺少 WebRTC 播放地址');
  }

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

async function fsPlayByHls(playback, videoEl) {
  if (!playback || !playback.hls_url) {
    throw new Error('缺少 HLS 播放地址');
  }

  if (fsCurrentHls) {
    fsCurrentHls.destroy();
    fsCurrentHls = null;
  }

  videoEl.srcObject = null;

  if (fsCanUseNativeHls(videoEl)) {
    videoEl.src = playback.hls_url;
    return videoEl.play();
  }

  const Hls = await fsEnsureHlsLibrary();
  if (!Hls || !Hls.isSupported()) {
    throw new Error('当前浏览器不支持 HLS（可尝试 WebRTC 或更换浏览器）');
  }

  fsCurrentHls = new Hls({
    enableWorker: true,
    lowLatencyMode: true,
    backBufferLength: 30
  });
  fsCurrentHls.loadSource(playback.hls_url);
  fsCurrentHls.attachMedia(videoEl);

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

    fsCurrentHls.once(Hls.Events.MANIFEST_PARSED, clearAndResolve);
    fsCurrentHls.on(Hls.Events.ERROR, onError);
  });

  return videoEl.play();
}

function fsStopPlayback() {
  const videoEl = document.getElementById('fsVideoPlayer');
  if (fsCurrentPeer) {
    fsCurrentPeer.close();
    fsCurrentPeer = null;
  }
  if (fsCurrentHls) {
    fsCurrentHls.destroy();
    fsCurrentHls = null;
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
        await fsPlayByHls(target.playback, videoEl);
        fsSetStatus(`播放中（HLS 回退）：${target.stream_name}`);
        return;
      }
    }

    await fsPlayByHls(target.playback, videoEl);
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
