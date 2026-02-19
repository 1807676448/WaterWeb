require('dotenv').config();
const express = require('express');
const path = require('path');
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
