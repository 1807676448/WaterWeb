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
import glob
import json
import os
import platform
import re
import signal
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_SERVER_BASE_URL = 'http://106.15.53.24'


def parse_args():
  parser = argparse.ArgumentParser(description='使用本机摄像头模拟 K230 实时推流')
  parser.add_argument('--device-id', default='device_pc_001', help='模拟设备 ID，默认 device_pc_001')
  parser.add_argument('--stream-name', default='', help='可选，自定义流名；不传默认 live/<device-id>')
  parser.add_argument('--server-base-url', default=DEFAULT_SERVER_BASE_URL, help=f'平台地址（用于 heartbeat），默认 {DEFAULT_SERVER_BASE_URL}')
  parser.add_argument('--rtsp-url', default='', help='可选，手动指定 RTSP 推流地址')
  parser.add_argument('--camera', default='', help='摄像头源，Windows 填设备名；Linux 填设备路径（如 /dev/video0）')
  parser.add_argument('--size', default='1280x720', help='分辨率，默认 1280x720')
  parser.add_argument('--fps', type=int, default=90, help='帧率，默认 90')
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


def is_loopback_server(server_base_url):
  parsed = urllib.parse.urlparse(server_base_url)
  host = (parsed.hostname or '').strip().lower()
  return host in {'127.0.0.1', 'localhost'}


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
  warned_404 = False
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
    except urllib.error.HTTPError as error:
      if error.code == 404 and not warned_404:
        print('[heartbeat] 上报失败: 404 Not Found（服务端缺少视频接口，请在服务器重新部署最新代码）')
        warned_404 = True
      elif error.code != 404:
        print(f'[heartbeat] 上报失败: HTTP {error.code}')
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



def list_windows_video_devices(ffmpeg_bin):
  cmd = [ffmpeg_bin, '-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']
  try:
    completed = subprocess.run(
      cmd,
      capture_output=True,
      text=True,
      encoding='utf-8',
      errors='ignore',
      timeout=8
    )
  except Exception:
    return []

  raw = '\n'.join([completed.stdout or '', completed.stderr or ''])
  matches = re.findall(r'"([^"]+)"\s+\(video\)', raw)

  dedup = []
  for name in matches:
    if name not in dedup:
      dedup.append(name)
  return dedup


def resolve_camera_input(args):
  current = platform.system().lower()
  source = str(args.camera or '').strip()

  if current != 'windows':
    return source

  devices = list_windows_video_devices(args.ffmpeg_bin)

  if source:
    if devices and source not in devices:
      print(f'[warning] 未找到摄像头: {source}')
      print(f'[hint] 可用摄像头: {", ".join(devices)}')
    return source

  if devices:
    chosen = devices[0]
    print(f'[info] 已自动选择摄像头: {chosen}')
    return chosen

  return source


def build_ffmpeg_input_args(args, capture_size, profile='auto'):
  current = platform.system().lower()
  source = str(args.camera or '').strip()
  fps = str(max(int(args.fps), 1))

  if current == 'windows':
    camera_name = source or 'Integrated Camera'
    if profile == 'aggressive':
      return [
        '-thread_queue_size', '1024',
        '-f', 'dshow',
        '-rtbufsize', '256M',
        '-framerate', fps,
        '-video_size', capture_size,
        '-i', f'video={camera_name}'
      ]
    if profile == 'compat':
      return [
        '-thread_queue_size', '1024',
        '-f', 'dshow',
        '-rtbufsize', '128M',
        '-i', f'video={camera_name}'
      ]
    return ['-f', 'dshow', '-i', f'video={camera_name}']

  if current == 'linux':
    device = source or '/dev/video0'
    if profile == 'aggressive':
      return [
        '-thread_queue_size', '1024',
        '-f', 'v4l2',
        '-framerate', fps,
        '-video_size', capture_size,
        '-i', device
      ]
    return ['-f', 'v4l2', '-i', device]

  if current == 'darwin':
    dev = source or '0'
    return ['-f', 'avfoundation', '-framerate', fps, '-i', f'{dev}:none']

  raise RuntimeError(f'暂不支持的系统: {current}')


def probe_ffmpeg_input(ffmpeg_bin, input_args):
  cmd = [
    ffmpeg_bin,
    '-hide_banner',
    '-loglevel',
    'error',
    *input_args,
    '-frames:v',
    '1',
    '-f',
    'null',
    '-'
  ]
  try:
    completed = subprocess.run(
      cmd,
      capture_output=True,
      text=True,
      encoding='utf-8',
      errors='ignore',
      timeout=10
    )
    return completed.returncode == 0
  except Exception:
    return False


def select_ffmpeg_input_args(args):
  width, height = parse_size(args.size)
  capture_size = f'{width}x{height}'
  current = platform.system().lower()

  if current == 'windows':
    candidates = [
      ('aggressive', build_ffmpeg_input_args(args, capture_size, 'aggressive')),
      ('compat', build_ffmpeg_input_args(args, capture_size, 'compat')),
      ('minimal', build_ffmpeg_input_args(args, capture_size, 'minimal'))
    ]
  elif current == 'linux':
    candidates = [
      ('aggressive', build_ffmpeg_input_args(args, capture_size, 'aggressive')),
      ('minimal', build_ffmpeg_input_args(args, capture_size, 'minimal'))
    ]
  else:
    return build_ffmpeg_input_args(args, capture_size, 'aggressive')

  for idx, (name, input_args) in enumerate(candidates):
    if probe_ffmpeg_input(args.ffmpeg_bin, input_args):
      if idx > 0:
        print(f'[info] 输入参数回退到 {name} 模式，避免摄像头驱动不兼容。')
      return input_args

  print('[warning] 预探测未找到可用输入参数，继续按最小兼容模式尝试推流。')
  return candidates[-1][1]



def build_ffmpeg_command(args, rtsp_url, input_args=None):
  width, height = parse_size(args.size)
  capture_size = f'{width}x{height}'
  resolved_input_args = input_args if input_args is not None else build_ffmpeg_input_args(args, capture_size, 'aggressive')
  cmd = [
    args.ffmpeg_bin,
    '-re',
    *resolved_input_args,
    '-s', capture_size,
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


def resolve_ffmpeg_bin(ffmpeg_bin):
  candidate = str(ffmpeg_bin or '').strip() or 'ffmpeg'

  # If user passes a path-like value, trust it when the file exists.
  if any(sep in candidate for sep in ('/', '\\')) or candidate.lower().endswith('.exe'):
    return candidate if os.path.exists(candidate) else ''

  found = shutil.which(candidate)
  if found:
    return found

  if platform.system().lower() == 'windows':
    user_profile = os.environ.get('USERPROFILE', '')
    local_appdata = os.environ.get('LOCALAPPDATA', '')
    common_windows_locations = [
      r'C:\ffmpeg\bin\ffmpeg.exe',
      r'C:\Program Files\ffmpeg\bin\ffmpeg.exe',
      r'C:\ProgramData\chocolatey\bin\ffmpeg.exe',
      os.path.join(user_profile, 'scoop', 'shims', 'ffmpeg.exe') if user_profile else ''
    ]
    for path in common_windows_locations:
      if path and os.path.exists(path):
        return path

    # winget installs FFmpeg under LOCALAPPDATA\Microsoft\WinGet\Packages by default.
    if local_appdata:
      pattern = os.path.join(
        local_appdata,
        'Microsoft',
        'WinGet',
        'Packages',
        'Gyan.FFmpeg_*',
        'ffmpeg-*',
        'bin',
        'ffmpeg.exe'
      )
      winget_candidates = glob.glob(pattern)
      if winget_candidates:
        winget_candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        return winget_candidates[0]

  return ''



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

  if is_loopback_server(args.server_base_url):
    print('[warning] 当前 server-base-url 指向本机地址，若要推送到云服务器请改为公网 IP。')

  ffmpeg_bin = resolve_ffmpeg_bin(args.ffmpeg_bin)
  if not ffmpeg_bin:
    print('[error] 未找到 ffmpeg 可执行文件。')
    print('请先安装 ffmpeg，或通过 --ffmpeg-bin 指定 ffmpeg.exe 的完整路径。')
    print('Windows 可选安装方式：winget install Gyan.FFmpeg 或 choco install ffmpeg')
    return 2

  args.ffmpeg_bin = ffmpeg_bin
  args.camera = resolve_camera_input(args)

  rtsp_url = args.rtsp_url.strip() or build_default_rtsp_url(args.server_base_url, args.device_id.strip())
  stream_name = args.stream_name.strip() or f'live/{args.device_id.strip()}'
  selected_input_args = select_ffmpeg_input_args(args)

  ffmpeg_cmd, width, height = build_ffmpeg_command(args, rtsp_url, selected_input_args)
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

  try:
    process = subprocess.Popen(ffmpeg_cmd)
  except FileNotFoundError:
    print(f'[error] 启动 ffmpeg 失败，找不到可执行文件: {args.ffmpeg_bin}')
    return 2

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
  except urllib.error.HTTPError as error:
    if error.code == 404:
      print('[heartbeat] 结束上报失败: 404 Not Found（服务端缺少视频接口，请在服务器重新部署最新代码）')
    else:
      print(f'[heartbeat] 结束上报失败: HTTP {error.code}')
  except urllib.error.URLError as error:
    print(f'[heartbeat] 结束上报失败: {error.reason}')
  except Exception as error:
    print(f'[heartbeat] 结束上报失败: {error}')

  print(f'推流结束，FFmpeg 退出码: {exit_code}')
  return 0 if exit_code == 0 else exit_code


if __name__ == '__main__':
  sys.exit(main())
