require('dotenv').config();
const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const config = require('./config');
const { initDb } = require('./db');
const apiRouter = require('./routes/api');
const { connectMqtt } = require('./services/mqttService');
const { ensureDirSync } = require('./services/imageUploadService');

async function bootstrap() {
  await initDb();
  ensureDirSync(config.upload.uploadDir);
  connectMqtt();

  const app = express();
  app.use(express.json());
  app.use(['/api', '/'], apiRouter);
  app.use(config.upload.publicBasePath, express.static(config.upload.uploadDir));

  // MediaMTX 代理 - WebRTC (WHEP)
  if (config.video.enabled && config.video.mtxWebrtcBackend) {
    app.use(
      '/mtx-webrtc',
      createProxyMiddleware({
        target: config.video.mtxWebrtcBackend,
        changeOrigin: true,
        pathRewrite: { '^/mtx-webrtc': '' },
        on: {
          error: (err, req, res) => {
            console.error('[mtx-webrtc proxy] error:', err.message);
          }
        }
      })
    );
    console.log(`[video] WebRTC proxy: /mtx-webrtc -> ${config.video.mtxWebrtcBackend}`);
  }

  // MediaMTX 代理 - HLS
  if (config.video.enabled && config.video.mtxHlsBackend) {
    app.use(
      '/mtx-hls',
      createProxyMiddleware({
        target: config.video.mtxHlsBackend,
        changeOrigin: true,
        pathRewrite: { '^/mtx-hls': '' },
        on: {
          error: (err, req, res) => {
            console.error('[mtx-hls proxy] error:', err.message);
          }
        }
      })
    );
    console.log(`[video] HLS proxy: /mtx-hls -> ${config.video.mtxHlsBackend}`);
  }

  app.use(express.static(path.resolve(__dirname, '../public')));

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.listen(config.port, () => {
    console.log(`Server started at http://0.0.0.0:${config.port}`);
  });
}

bootstrap().catch((error) => {
  console.error('bootstrap error:', error);
  process.exit(1);
});
