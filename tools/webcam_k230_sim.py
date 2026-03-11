"""
webcam_k230_sim.py

用途：
  使用本机摄像头模拟 K230 设备，通过 WiFi/网络向服务器推送实时视频流。

实现方式：
  - 调用 FFmpeg 从摄像头采集视频并编码为 H264
  - 推送至 MediaMTX RTSP：rtsp://<server-host>:8554/live/<device_id>
  - 定时向平台接口 /api/video/heartbeat 上报流状态

依赖：
  - 本机安装 ffmpeg（确保命令行可直接执行）
  - Python 3.8+
"""

import argparse
import json
import platform
import signal
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request


def parse_args():
  parser = argparse.ArgumentParser(description='使用本机摄像头模拟 K230 实时推流')
  parser.add_argument('--device-id', default='device_pc_001', help='模拟设备 ID，默认 device_pc_001')
  parser.add_argument('--stream-name', default='', help='可选，自定义流名；不传默认 live/<device-id>')
  parser.add_argument('--server-base-url', default='http://127.0.0.1', help='平台地址（用于 heartbeat），默认 http://127.0.0.1')
  parser.add_argument('--rtsp-url', default='', help='可选，手动指定 RTSP 推流地址')
  parser.add_argument('--camera', default='', help='摄像头源，Windows 填设备名；Linux 填设备路径（如 /dev/video0）')
  parser.add_argument('--size', default='1280x720', help='分辨率，默认 1280x720')
  parser.add_argument('--fps', type=int, default=15, help='帧率，默认 15')
  parser.add_argument('--bitrate', default='1500k', help='视频码率，默认 1500k')
  parser.add_argument('--codec', default='h264', help='编码标识上报值，默认 h264')
  parser.add_argument('--source', default='pc-webcam-sim', help='来源标识上报值')
  parser.add_argument('--heartbeat-interval', type=int, default=5, help='心跳间隔秒，默认 5')
  parser.add_argument('--token', default='', help='上传令牌（若服务端配置了 UPLOAD_TOKEN 则必填）')
  parser.add_argument('--ffmpeg-bin', default='ffmpeg', help='ffmpeg 可执行文件路径，默认 ffmpeg')
  parser.add_argument('--dry-run', action='store_true', help='仅打印 ffmpeg 命令，不执行')
  return parser.parse_args()


def parse_size(size_text):
  value = str(size_text or '').lower().strip()
  parts = value.split('x')
  if len(parts) != 2:
    raise ValueError('size 格式必须是 <width>x<height>，例如 1280x720')

  width = int(parts[0])
  height = int(parts[1])
  if width < 16 or height < 16:
    raise ValueError('分辨率太小')

  return width, height


def build_default_rtsp_url(server_base_url, device_id):
  parsed = urllib.parse.urlparse(server_base_url)
  host = parsed.hostname or '127.0.0.1'
  stream_name = f'live/{device_id}'
  return f'rtsp://{host}:8554/{stream_name}'


def post_heartbeat(server_base_url, payload, token=''):
  url = f"{server_base_url.rstrip('/')}/api/video/heartbeat"
  body = json.dumps(payload, ensure_ascii=False).encode('utf-8')

  headers = {
    'Content-Type': 'application/json'
  }
  if token:
    headers['X-Upload-Token'] = token

  request = urllib.request.Request(url, data=body, headers=headers, method='POST')
  with urllib.request.urlopen(request, timeout=8) as response:
    response.read()
    return response.getcode()


def heartbeat_loop(stop_event, args, rtsp_url, stream_name, width, height):
  while not stop_event.is_set():
    payload = {
      'device_id': args.device_id,
      'stream_name': stream_name,
      'status': 'online',
      'codec': args.codec,
      'width': width,
      'height': height,
      'fps': args.fps,
      'bitrate_kbps': parse_kbps(args.bitrate),
      'source': args.source,
      'rtsp_url': rtsp_url
    }
    try:
      post_heartbeat(args.server_base_url, payload, args.token)
    except Exception as error:
      print(f'[heartbeat] 上报失败: {error}')

    stop_event.wait(max(args.heartbeat_interval, 2))



def parse_kbps(bitrate_text):
  value = str(bitrate_text or '').strip().lower()
  if value.endswith('k'):
    return int(float(value[:-1]))
  if value.endswith('m'):
    return int(float(value[:-1]) * 1000)
  return int(float(value) / 1000)



def build_ffmpeg_input_args(camera):
  current = platform.system().lower()
  source = str(camera or '').strip()

  if current == 'windows':
    camera_name = source or 'Integrated Camera'
    return ['-f', 'dshow', '-i', f'video={camera_name}']

  if current == 'linux':
    device = source or '/dev/video0'
    return ['-f', 'v4l2', '-i', device]

  if current == 'darwin':
    dev = source or '0'
    return ['-f', 'avfoundation', '-i', f'{dev}:none']

  raise RuntimeError(f'暂不支持的系统: {current}')



def build_ffmpeg_command(args, rtsp_url):
  width, height = parse_size(args.size)
  cmd = [
    args.ffmpeg_bin,
    '-re',
    *build_ffmpeg_input_args(args.camera),
    '-s', f'{width}x{height}',
    '-r', str(args.fps),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-b:v', args.bitrate,
    '-rtsp_transport', 'tcp',
    '-f', 'rtsp',
    rtsp_url
  ]
  return cmd, width, height



def terminate_process(process):
  if process.poll() is not None:
    return

  try:
    process.terminate()
    process.wait(timeout=5)
  except Exception:
    process.kill()



def main():
  args = parse_args()

  if not args.device_id.strip():
    print('device-id 不能为空')
    return 1

  rtsp_url = args.rtsp_url.strip() or build_default_rtsp_url(args.server_base_url, args.device_id.strip())
  stream_name = args.stream_name.strip() or f'live/{args.device_id.strip()}'

  ffmpeg_cmd, width, height = build_ffmpeg_command(args, rtsp_url)
  print('FFmpeg 命令:')
  print(' '.join(ffmpeg_cmd))

  if args.dry_run:
    return 0

  stop_event = threading.Event()
  heartbeat_thread = threading.Thread(
    target=heartbeat_loop,
    args=(stop_event, args, rtsp_url, stream_name, width, height),
    daemon=True
  )

  process = subprocess.Popen(ffmpeg_cmd)

  def handle_stop(signum, frame):
    del signum, frame
    stop_event.set()
    terminate_process(process)

  signal.signal(signal.SIGINT, handle_stop)
  signal.signal(signal.SIGTERM, handle_stop)

  heartbeat_thread.start()

  print('开始推流，按 Ctrl+C 停止。')
  exit_code = process.wait()
  stop_event.set()

  try:
    post_heartbeat(
      args.server_base_url,
      {
        'device_id': args.device_id,
        'stream_name': stream_name,
        'status': 'offline',
        'codec': args.codec,
        'width': width,
        'height': height,
        'fps': args.fps,
        'bitrate_kbps': parse_kbps(args.bitrate),
        'source': args.source,
        'rtsp_url': rtsp_url
      },
      args.token
    )
  except urllib.error.URLError as error:
    print(f'[heartbeat] 结束上报失败: {error.reason}')
  except Exception as error:
    print(f'[heartbeat] 结束上报失败: {error}')

  print(f'推流结束，FFmpeg 退出码: {exit_code}')
  return 0 if exit_code == 0 else exit_code


if __name__ == '__main__':
  sys.exit(main())
