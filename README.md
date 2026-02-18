# MQTT 水质检测数据平台

本项目用于在阿里云轻应用服务器上运行一个基于 MQTT 的水质检测平台，支持：

- 接收设备上报水质数据并存入 SQLite 数据库
- 接收设备/平台指令并向设备下发当前时间戳
- 设备管理页面展示设备状态与运行时长
- DeepSeek 分析最近 10 次水质数据并输出 AI 结论

## 1. 环境要求

- Node.js 18+
- 可访问的 MQTT Broker（如 EMQX/Mosquitto）
- （可选）DeepSeek API Key

## 2. 在 VS Code + SSH 场景部署

1. 使用 VS Code 的 Remote SSH 连接阿里云服务器
2. 打开本工程目录
3. 安装依赖：

```bash
npm install
```

4. 配置环境变量：

```bash
cp .env.example .env
```

根据实际情况修改 `.env`：

- `MQTT_URL`：MQTT 地址
- `MQTT_UPLINK_TOPIC`：设备上报主题（默认 `devices/+/up`）
- `MQTT_STATUS_TOPIC`：设备状态主题（默认 `devices/+/status`）
- `MQTT_COMMAND_TOPIC`：设备命令主题（默认 `devices/+/command`）
- `MQTT_DOWNLINK_TOPIC_TEMPLATE`：下发主题模板（默认 `devices/{device_id}/down`）
- `DEEPSEEK_API_KEY`：DeepSeek Key（可选）

5. 启动服务：

```bash
npm run dev
```

6. 浏览器访问：

- 数据展示页：`http://服务器IP:3000/index.html`
- 设备管理页：`http://服务器IP:3000/devices.html`
- DeepSeek 分析页：`http://服务器IP:3000/deepseek.html`
- 指令执行页：`http://服务器IP:3000/commands.html`

## 3. 功能说明

### 3.1 MQTT 上报数据接收与入库

系统订阅 `MQTT_UPLINK_TOPIC`（默认 `devices/+/up`），处理如下格式：

```json
{
  "id": "1",
  "params": {
    "TDS": { "value": 123 },
    "COD": { "value": 45 },
    "TOC": { "value": 1.2 },
    "UV254": { "value": 0.023 },
    "pH": { "value": 7.2 },
    "Tem": { "value": 22.5 },
    "Tur": { "value": 0.8 },
    "air_temp": { "value": 21.0 },
    "air_hum": { "value": 55 },
    "pressure": { "value": 1013 },
    "altitude": { "value": 30 }
  }
}
```

页面可按设备和时间范围查询并展示（图表 + 表格）。

### 3.2 指令接收与下发当前时间戳

支持指令格式：

```json
{"device_id":"device_002","command":"time"}
```

处理方式：

- MQTT 订阅到 `devices/+/command` 时自动处理
- 或调用 HTTP 接口：`POST /api/iot/command`

当 `command = time` 时，系统向 `devices/{device_id}/down` 下发：

```json
{"timestamp": 1760000000000}
```

### 3.3 设备管理页面

系统订阅 `MQTT_STATUS_TOPIC`（默认 `devices/+/status`），建议设备上报：

```json
{"status":"online","runtime_seconds":3600}
```

页面展示：

- 设备在线/离线状态（120 秒未更新自动判定离线）
- 设备运行时长（秒）
- 最近在线时间和更新时间

### 3.4 DeepSeek 分析页面

用户点击“请求 DeepSeek 分析”后，后端读取最近 10 次水质数据并调用 DeepSeek API，返回分析结果。

接口：`POST /api/analysis/deepseek`

请求体（可选设备）：

```json
{"device_id":"device_002"}
```

## 4. 主要目录

```text
src/
  server.js
  config.js
  db.js
  routes/api.js
  services/
    mqttService.js
    deviceService.js
    deepseekService.js
public/
  index.html
  devices.html
  deepseek.html
  styles.css
  scripts/
    index.js
    devices.js
    deepseek.js
```

## 5. 测试接口示例

### 5.1 手动下发 time 指令（HTTP）

```bash
curl -X POST http://127.0.0.1:3000/api/iot/command \
  -H "Content-Type: application/json" \
  -d '{"device_id":"device_002","command":"time"}'
```

### 5.2 查询范围数据

```bash
curl "http://127.0.0.1:3000/api/metrics?device_id=device_002&limit=50"
```

## 6. 备注

- 数据库文件默认保存在 `data/water_quality.db`
- 若未配置 `DEEPSEEK_API_KEY`，分析页会返回本地兜底提示文本

## 7. 阿里云服务器部署方案（推荐生产）

以下方案适用于通过 VS Code Remote SSH 登录阿里云轻应用服务器后执行。

### 7.1 服务器初始化

```bash
sudo apt update
sudo apt install -y nginx rsync
```

安装 Node.js（18+，示例使用 NodeSource）：

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 7.2 开放端口（安全组 + 系统防火墙）

- 阿里云控制台安全组放行 `80`（若暂不走 Nginx，可放行 `3000`）
- 若服务器启用了 UFW：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 22/tcp
sudo ufw status
```

### 7.3 首次部署

在项目根目录执行：

```bash
bash deploy/scripts/deploy.sh
```

> 首次执行会在 `/opt/mqtt-water-quality-platform/.env` 不存在时自动生成并退出，请先编辑 `.env` 后再次执行。

编辑生产环境配置：

```bash
sudo nano /opt/mqtt-water-quality-platform/.env
```

至少确认以下项正确：

- `MQTT_URL`
- `MQTT_UPLINK_TOPIC`
- `MQTT_STATUS_TOPIC`
- `MQTT_COMMAND_TOPIC`
- `MQTT_DOWNLINK_TOPIC_TEMPLATE`
- `DEEPSEEK_API_KEY`（可选）

再次执行部署：

```bash
bash deploy/scripts/deploy.sh
```

### 7.4 systemd 服务管理

服务名：`water-quality-platform`

```bash
sudo systemctl status water-quality-platform
sudo systemctl restart water-quality-platform
sudo journalctl -u water-quality-platform -f
```

默认服务文件位置：

- `/etc/systemd/system/water-quality-platform.service`

如果你服务器没有 `www-data` 用户，请修改服务文件中的 `User=`（例如改为你的部署用户），然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart water-quality-platform
```

### 7.5 Nginx 反向代理

已自动安装配置：

- `/etc/nginx/conf.d/mqtt-water-quality-platform.conf`

验证与重载：

```bash
sudo nginx -t
sudo systemctl restart nginx
```

访问地址：

- `http://你的服务器公网IP/index.html`
- `http://你的服务器公网IP/devices.html`
- `http://你的服务器公网IP/deepseek.html`
- `http://你的服务器公网IP/commands.html`

若访问公网 IP 出现 `404 Not Found (nginx/1.24.0)`，通常是命中了 Ubuntu 默认站点。可执行：

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

并检查当前生效配置：

```bash
sudo nginx -T | grep -n "water-quality-platform.conf\|default_server\|proxy_pass"
```

### 7.6 后续更新发布

每次代码更新后，在项目目录执行：

```bash
bash deploy/scripts/deploy.sh
```

该脚本会自动：同步代码、安装依赖、重启服务、重载 Nginx。

### 7.7 常见错误：502 Bad Gateway

当 `curl http://127.0.0.1:3000/health` 失败且页面出现 `502`，说明 Node 服务未监听 3000。优先排查：

```bash
sudo systemctl status water-quality-platform -l --no-pager
sudo journalctl -u water-quality-platform -n 100 --no-pager
sudo ss -ltnp | grep 3000 || true
```

如果日志包含 `EACCES`（目录或数据库权限不足），重新执行部署脚本即可自动修复权限：

```bash
cd /home/admin/WaterWeb
bash deploy/scripts/deploy.sh
```

## 8. MQTT 本地连接与订阅说明

本节用于“本地设备（开发机） ↔ 阿里云服务器 MQTT Broker”的联调。

### 8.1 连接关系

- 服务器上的平台服务（Node）建议连接本机 Broker：`MQTT_URL=mqtt://127.0.0.1:1883`
- 本地设备（开发机）连接服务器公网地址：`mqtt://106.15.53.24:1883`

> 若出现 `ECONNREFUSED 106.15.53.24:1883`，通常是 Broker 仅监听 `127.0.0.1` 或安全组未放行 `1883/tcp`。

### 8.2 Topic 规范（当前工程默认）

- 数据上报：`devices/{device_id}/up`
- 状态心跳：`devices/{device_id}/status`
- 指令入口：`devices/{device_id}/command`
- 平台下行：`devices/{device_id}/down`

示例设备 ID：`device_002`

### 8.3 本地端发布（模拟设备）

在本地开发机安装 `mosquitto-clients` 后执行。

1) 上报水质数据：

```bash
mosquitto_pub -h 106.15.53.24 -p 1883 -t devices/device_002/up -m '{"id":"1","params":{"TDS":{"value":123},"COD":{"value":45},"TOC":{"value":1.2},"UV254":{"value":0.023},"pH":{"value":7.2},"Tem":{"value":22.5},"Tur":{"value":0.8},"air_temp":{"value":21.0},"air_hum":{"value":55},"pressure":{"value":1013},"altitude":{"value":30}}}'
```

2) 上报设备状态（建议每 60 秒一次）：

```bash
mosquitto_pub -h 106.15.53.24 -p 1883 -t devices/device_002/status -m '{"device_id":"device_002","status":"online","runtime_seconds":3600}'
```

### 8.4 本地端订阅（接收服务器下发）

订阅下行 Topic：

```bash
mosquitto_sub -h 106.15.53.24 -p 1883 -t devices/device_002/down -v
```

### 8.5 通过 MQTT 触发时间戳下发（推荐）

1) 先在本地开一个订阅窗口（接收下发）：

```bash
mosquitto_sub -h 106.15.53.24 -p 1883 -t devices/device_002/down -v
```

2) 再发布命令到设备命令 Topic：

```bash
mosquitto_pub -h 106.15.53.24 -p 1883 -t devices/device_002/command -m '{"device_id":"device_002","command":"time"}'
```

如果链路正常，订阅窗口会收到类似：

```json
devices/device_002/down {"timestamp":1760000000000}
```

> 说明：平台仍支持 `POST /api/iot/command`，但这是给管理端/平台端用的备用入口；设备联调建议优先使用 MQTT 命令主题。

### 8.6 联调检查清单

- 服务器 `1883/tcp` 已监听在 `0.0.0.0`：`sudo ss -ltnp | grep 1883`
- 阿里云安全组已放行 `1883/tcp`
- 平台服务已启动：`sudo systemctl status water-quality-platform`
- 设备持续上报 `status`，否则设备页 3 分钟后显示离线

## 9. 性能与稳定性优化（已内置）

为解决高频刷新下的 `504 Gateway Time-out` 与服务卡顿，工程已包含以下优化：

- SQLite 启用 `WAL`、`busy_timeout`，降低读写锁冲突
- 水质表增加索引：`created_at`、`(device_id, created_at)`
- 指标查询 `limit` 设置上限（最大 300）
- 实时刷新模式自动使用较小查询量（前端默认 120 条）
- 前端数据签名未变化时跳过重绘，降低图表渲染负载

### 9.1 线上建议

- 尽量避免同时打开过多监控页面
- 若服务器规格较低，建议把前端刷新间隔从 `3s` 调整为 `5s` 或 `10s`
- 若出现 504，请优先检查：

```bash
sudo systemctl status water-quality-platform -l --no-pager
sudo journalctl -u water-quality-platform -n 120 --no-pager
curl -m 5 -i http://127.0.0.1:3000/health
curl -m 5 -i "http://127.0.0.1:3000/api/metrics?limit=10"
```
