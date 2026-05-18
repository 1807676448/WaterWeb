"""
k230_hotspot_relay.py

用途：
  K230 连接到 Win11 热点后，通过 Win11 电脑作为中继将 RTSP 流转发至云平台，并上报心跳。

实现方式：
  - 调用 FFmpeg 从局域网 K230 RTSP 地址拉流，并原样（copy）推送到公网 MediaMTX。
  - 定时向平台接口 /api/video/heartbeat 上报流状态。
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_SERVER_BASE_URL = 'http://106.15.53.24'

def parse_args():
    parser = argparse.ArgumentParser(description='Win11热点中继 K230 RTSP 流并上报心跳')
    parser.add_argument('--k230-rtsp', required=True, help='K230 在局域网内的 RTSP 地址，如 rtsp://192.168.137.52:8554/test')
    parser.add_argument('--device-id', default='device_k230_001', help='目标平台模拟设备 ID')
    parser.add_argument('--server-base-url', default=DEFAULT_SERVER_BASE_URL, help='平台 HTTP 地址，用于上报心跳')
    parser.add_argument('--ffmpeg-bin', default='ffmpeg', help='ffmpeg 可执行文件路径')
    parser.add_argument('--token', default='', help='API 上传令牌')

    # 中继优化选项
    parser.add_argument('--relay-mode', choices=['copy', 'transcode'], default='copy', help='copy=不转码低占用；transcode=重编码稳帧')
    parser.add_argument('--source-transport', choices=['auto', 'tcp', 'udp'], default='auto', help='拉取 K230 流使用协议，auto=先 udp 无帧自动回退 tcp')
    parser.add_argument('--target-transport', choices=['tcp', 'udp'], default='tcp', help='推送到 MediaMTX 使用协议，公网建议 tcp')
    parser.add_argument('--rw-timeout-ms', type=int, default=15000, help='RTSP 输入超时（毫秒，映射到 ffmpeg -timeout）')
    parser.add_argument('--input-buffer-ms', type=int, default=500, help='输入最大缓冲（毫秒）')
    parser.add_argument('--analyze-duration-ms', type=int, default=5000, help='输入流探测时长（毫秒）')
    parser.add_argument('--probe-size', type=int, default=1048576, help='输入流探测大小（字节）')
    parser.add_argument('--ffmpeg-loglevel', default='warning', help='FFmpeg 日志级别，例如 warning/info/debug')
    parser.add_argument('--startup-no-frame-timeout-sec', type=int, default=12, help='启动后仍无帧时强制重启阈值（秒，<=0 关闭）')
    parser.add_argument('--restart-delay-sec', type=int, default=2, help='中继异常退出后的重启等待秒数')
    parser.add_argument('--max-restarts', type=int, default=0, help='最大重启次数，0 表示无限重启')

    parser.add_argument('--low-latency', dest='low_latency', action='store_true', help='启用低延迟参数（会牺牲部分稳态能力）')
    parser.add_argument('--no-low-latency', dest='low_latency', action='store_false', help='关闭低延迟参数')
    parser.set_defaults(low_latency=False)

    # transcode 模式参数
    parser.add_argument('--fps', type=int, default=20, help='transcode 模式目标帧率')
    parser.add_argument('--video-bitrate-kbps', type=int, default=1200, help='transcode 模式目标码率（kbps）')
    parser.add_argument('--gop', type=int, default=40, help='transcode 模式 GOP 长度')
    return parser.parse_args()

def build_ffmpeg_cmd(args, target_rtsp_url, source_transport):
    cmd = [args.ffmpeg_bin]

    # 输出统计信息，便于观察实际帧率变化
    cmd += ['-loglevel', args.ffmpeg_loglevel, '-stats']

    # 某些 K230 固件时间戳不连续，使用本地时钟可避免大量 dts/pts 警告
    cmd += ['-use_wallclock_as_timestamps', '1']

    if source_transport and source_transport != 'auto':
        cmd += ['-rtsp_transport', source_transport]

    # 部分 ffmpeg 构建不支持 rw_timeout，RTSP 输入优先使用兼容性更好的 timeout
    cmd += ['-timeout', str(args.rw_timeout_ms * 1000)]
    cmd += ['-analyzeduration', str(args.analyze_duration_ms * 1000)]
    cmd += ['-probesize', str(args.probe_size)]
    cmd += ['-max_delay', str(args.input_buffer_ms * 1000)]

    if args.low_latency:
        cmd += ['-fflags', 'nobuffer', '-flags', 'low_delay']

    cmd += ['-i', args.k230_rtsp, '-an']

    if args.relay_mode == 'copy':
        cmd += ['-c:v', 'copy']
    else:
        bitrate = max(300, args.video_bitrate_kbps)
        gop = max(2, args.gop)
        fps = max(1, args.fps)
        cmd += [
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-r', str(fps),
            '-g', str(gop),
            '-b:v', f'{bitrate}k',
            '-maxrate', f'{bitrate}k',
            '-bufsize', f'{bitrate * 2}k'
        ]

    cmd += ['-f', 'rtsp', '-rtsp_transport', args.target_transport, target_rtsp_url]
    return cmd

def post_heartbeat(server_base_url, payload, token=''):
    url = f"{server_base_url.rstrip('/')}/api/video/heartbeat"
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['X-Upload-Token'] = token

    request = urllib.request.Request(url, data=body, headers=headers, method='POST')
    with urllib.request.urlopen(request, timeout=8) as response:
        response.read()

def heartbeat_loop(stop_event, args, target_rtsp_url, stream_name):
    # K230默认推流常见配置作为心跳展示
    payload = {
        'device_id': args.device_id,
        'stream_name': stream_name,
        'status': 'online',
        'codec': 'h264',
        'width': 1280,
        'height': 720,
        'fps': 30,
        'bitrate_kbps': 1500,
        'source': 'k230-hotspot-relay',
        'rtsp_url': target_rtsp_url
    }
    
    warned_404 = False
    while not stop_event.is_set():
        try:
            post_heartbeat(args.server_base_url, payload, args.token)
        except urllib.error.HTTPError as error:
            if error.code == 404 and not warned_404:
                print('[heartbeat] 接口 404，请确认服务端代码已更新。')
                warned_404 = True
            elif error.code != 404:
                print(f'[heartbeat] 上报失败 HTTP {error.code}')
        except Exception as e:
            print(f'[heartbeat] 上报失败: {e}')
        
        stop_event.wait(5)

def get_target_rtsp_url(server_base_url, stream_name):
    host = urllib.parse.urlparse(server_base_url).hostname or '127.0.0.1'
    return f"rtsp://{host}:8554/{stream_name}"

def terminate_process(process):
    if process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(5)
    except Exception:
        process.kill()

def build_transport_sequence(source_transport):
    if source_transport == 'auto':
        return ['udp', 'tcp']
    return [source_transport]

def run_ffmpeg_once(ffmpeg_cmd, no_frame_timeout_sec, stop_event, process_holder=None):
    frame_pattern = re.compile(r'frame=\s*(\d+)')
    state = {
        'seen_frame': False,
        'start_time': time.time(),
        'last_stats_print': 0.0,
    }

    process = subprocess.Popen(
        ffmpeg_cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding='utf-8',
        errors='ignore',
        bufsize=1,
    )
    if process_holder is not None:
        process_holder['process'] = process

    def stderr_reader():
        buffer = ''
        while True:
            ch = process.stderr.read(1)
            if not ch:
                break
            if ch in ('\r', '\n'):
                line = buffer.strip()
                buffer = ''
                if not line:
                    continue

                match = frame_pattern.search(line)
                if match:
                    frame_value = int(match.group(1))
                    if frame_value > 0:
                        state['seen_frame'] = True

                    now = time.time()
                    if now - state['last_stats_print'] >= 1.0:
                        print(line)
                        state['last_stats_print'] = now
                else:
                    print(line)
            else:
                buffer += ch

        if buffer.strip():
            print(buffer.strip())

    reader_thread = threading.Thread(target=stderr_reader, daemon=True)
    reader_thread.start()

    no_frame_triggered = False
    while process.poll() is None:
        if stop_event.is_set():
            terminate_process(process)
            break

        if (
            no_frame_timeout_sec > 0
            and not state['seen_frame']
            and (time.time() - state['start_time']) >= no_frame_timeout_sec
        ):
            no_frame_triggered = True
            print(f"[warn] 启动 {no_frame_timeout_sec}s 仍未收到视频帧，准备重启 FFmpeg")
            terminate_process(process)
            break

        time.sleep(0.2)

    exit_code = process.wait()
    reader_thread.join(timeout=1.0)
    if process_holder is not None:
        process_holder['process'] = None
    return exit_code, state['seen_frame'], no_frame_triggered

def main():
    args = parse_args()
    stream_name = f"live/{args.device_id}"
    target_rtsp_url = get_target_rtsp_url(args.server_base_url, stream_name)
    transport_candidates = build_transport_sequence(args.source_transport)

    stop_event = threading.Event()
    heartbeat_thread = threading.Thread(
        target=heartbeat_loop,
        args=(stop_event, args, target_rtsp_url, stream_name),
        daemon=True
    )

    process_holder = {'process': None}

    def handle_stop(signum, frame):
        stop_event.set()
        if process_holder['process'] is not None:
            terminate_process(process_holder['process'])

    signal.signal(signal.SIGINT, handle_stop)
    signal.signal(signal.SIGTERM, handle_stop)

    heartbeat_thread.start()
    print("[INFO] 中继并上报心跳中... 按 Ctrl+C 退出")

    exit_code = 0
    restart_count = 0
    transport_idx = 0

    while not stop_event.is_set():
        source_transport = transport_candidates[min(transport_idx, len(transport_candidates) - 1)]
        ffmpeg_cmd = build_ffmpeg_cmd(args, target_rtsp_url, source_transport)
        print("启动中继指令：", " ".join(ffmpeg_cmd))

        try:
            exit_code, seen_frame, no_frame_triggered = run_ffmpeg_once(
                ffmpeg_cmd,
                args.startup_no_frame_timeout_sec,
                stop_event,
                process_holder,
            )
        except FileNotFoundError:
            print("[error] 未找到 ffmpeg。")
            exit_code = 1
            break

        if stop_event.is_set():
            break

        if exit_code == 0 and seen_frame and not no_frame_triggered:
            print('[INFO] FFmpeg 正常退出')
            break

        if no_frame_triggered and args.source_transport == 'auto' and transport_idx + 1 < len(transport_candidates):
            transport_idx += 1
            print(f"[warn] 当前传输 {source_transport} 启动无帧，自动切换到 {transport_candidates[transport_idx]}")

        restart_count += 1
        if args.max_restarts > 0 and restart_count > args.max_restarts:
            print(f"[error] 已达到最大重启次数 {args.max_restarts}，停止中继")
            break

        delay_sec = max(0, args.restart_delay_sec)
        print(f"[INFO] FFmpeg 退出码 {exit_code}，{delay_sec}s 后重启（第 {restart_count} 次）")
        if stop_event.wait(delay_sec):
            break

    stop_event.set()

    # 退出前发送 offline 状态
    try:
        post_heartbeat(args.server_base_url, {
            'device_id': args.device_id,
            'stream_name': stream_name,
            'status': 'offline',
            'codec': 'h264',
            'width': 1280,
            'height': 720,
            'fps': 30,
            'bitrate_kbps': 1500,
            'source': 'k230-hotspot-relay',
            'rtsp_url': target_rtsp_url
        }, args.token)
    except Exception:
        pass

    print("[INFO] 中继已停止")
    return exit_code

if __name__ == '__main__':
    sys.exit(main())