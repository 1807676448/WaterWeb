const fs = require('fs/promises');
const path = require('path');
const config = require('../src/config');
const { initDb, run, db } = require('../src/db');

function hasArg(flag) {
  return process.argv.includes(flag);
}

async function clearUploadFiles() {
  const dirPath = config.upload.uploadDir;
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { removed: 0 };
    }
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dirPath, entry.name);
    await fs.unlink(filePath);
    removed += 1;
  }

  return { removed };
}

async function closeDb() {
  await new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const withFiles = hasArg('--with-files');

  await initDb();

  try {
    await run('BEGIN IMMEDIATE TRANSACTION');
    await run('DELETE FROM water_quality');
    await run('DELETE FROM devices');
    await run('DELETE FROM commands');
    await run('DELETE FROM analysis_reports');
    await run('DELETE FROM image_uploads');
    await run("DELETE FROM sqlite_sequence WHERE name IN ('water_quality', 'commands', 'analysis_reports', 'image_uploads')");
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    throw error;
  }

  let removedFileCount = 0;
  if (withFiles) {
    const fileResult = await clearUploadFiles();
    removedFileCount = fileResult.removed;
  }

  console.log('[db:clear] 数据库已清空');
  if (withFiles) {
    console.log(`[db:clear] 上传目录已清理，删除文件 ${removedFileCount} 个`);
  }
}

main()
  .catch((error) => {
    console.error('[db:clear] 执行失败:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => {});
  });
