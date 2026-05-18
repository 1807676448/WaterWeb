# canmv_k230_rtsp_server.py
# 运行环境：K230 开发板 (CanMV IDE 环境)
# 作用：连接局域网（如 Win11 热点），启动摄像头，并在本地开启 RTSP 推流服务器。

import network
import time
import os
import _thread
import uctypes
import sys
import socket
import json
from time import sleep
from machine import PWM, Pin, FPIOA

# ---------- 请将这里修改为您的局域网/Wi-Fi/Win11热点信息 ----------
WIFI_SSID = "Java"      
WIFI_PASSWORD = "13700000"  
# ----------------------------------------------------------------

# ---------- 云台控制负载调优参数 ----------
# 默认关闭高频角度日志，避免串口打印影响实时性
PAN_TILT_VERBOSE = False
PAN_TILT_LOG_INTERVAL_S = 1.0
# 自动巡航角度更新间隔（秒），由原 0.1s 调整为 0.2s
AUTO_SWEEP_INTERVAL_S = 0.2
# 默认关闭自动巡航，避免空闲时持续PWM更新影响图传
AUTO_SWEEP_DEFAULT_ENABLED = False
# 不连接云台或排障时可关闭，彻底隔离 PWM/UDP 控制逻辑
ENABLE_PAN_TILT = True

# ---------- RTSP 推流稳态参数 ----------
# 单包发送超时（毫秒），过大容易在网络抖动时长时间阻塞推流线程
RTSP_SEND_TIMEOUT_MS = 40
# GetStream 超时时间（毫秒），避免完全非阻塞导致CPU空转
GET_STREAM_TIMEOUT_MS = 20
# 编码输出缓冲个数，建议在 16~32 之间按固件内存情况调节
VENC_OUT_BUF_NUM = 24
# 是否打印单包发送错误（建议排障时打开）
RTSP_SEND_VERBOSE = False
# 是否打印 SPS/PPS 补齐行为（用于排障）
H264_PARAM_VERBOSE = False
# 是否打印周期性推流统计，默认关闭避免串口打印影响实时性
RTSP_STATS_VERBOSE = False
RTSP_STATS_INTERVAL_S = 2.0
# -----------------------------------------

from media.vencoder import *
from media.sensor import *
from media.media import *
import multimedia as mm

def connect_wifi():
    print("正在初始化网络...")
    sta = network.WLAN(network.STA_IF)
    sta.active(True)
    
    # [修改点]: 给网络模块和 Media 层的内存缓冲释放预留一点时间
    time.sleep(1)
    
    print("正在扫描附近的 Wi-Fi 网络...")
    try:
        wifi_list = sta.scan()
        print(f"共检测到 {len(wifi_list)} 个 Wi-Fi 网络:")
        for w in wifi_list:
            try:
                # 兼容 CanMV K230 的 rt_wlan_info 对象和常规元组
                if hasattr(w, 'ssid'):
                    ssid = w.ssid
                    rssi = getattr(w, 'rssi', '未知')
                else:
                    ssid = w[0]
                    rssi = w[3]

                if isinstance(ssid, bytes):
                    ssid = ssid.decode('utf-8', 'ignore')
                    
                print(f"  - SSID: {ssid}, 信号强度: {rssi} dBm")
            except Exception as inner_e:
                print(f"  - [解析失败] 未知 Wi-Fi 格式: {w} ({inner_e})")
    except Exception as e:
        print(f"扫描 Wi-Fi 失败: {e}")

    print(f"\n正在尝试连接到: {WIFI_SSID} ...")
    sta.connect(WIFI_SSID, WIFI_PASSWORD)
    
    timeout = 30  # 超时时间，DHCP可能需要较长时间
    start_time = time.time()
    while not sta.isconnected() or sta.ifconfig()[0] == '0.0.0.0':
        if time.time() - start_time > timeout:
            print("[错误] Wi-Fi 连接/获取IP超时，请检查密码或热点是否正确工作")
            return None
        time.sleep(1)
        
    ip_config = sta.ifconfig()
    print("[成功] Wi-Fi 已连接, K230 IP地址:", ip_config[0])
    return ip_config[0]

class RtspServer:
    def __init__(self, session_name="test", port=8554, video_type=mm.multi_media_type.media_h264, enable_audio=False):
        self.session_name = session_name
        self.video_type = video_type
        self.enable_audio = enable_audio
        self.port = port
        self.rtspserver = mm.rtsp_server()
        self.venc_chn = VENC_CHN_ID_0
        self.start_stream = False
        self.runthread_over = False
        self._h264_sps = None
        self._h264_pps = None
        self._frame_count = 0
        self._last_stats_time = time.time()

    def _find_nalu_spans(self, stream_data):
        spans = []
        data_len = len(stream_data)
        i = 0
        while i <= data_len - 4:
            sc_len = 0
            if stream_data[i] == 0 and stream_data[i + 1] == 0:
                if stream_data[i + 2] == 1:
                    sc_len = 3
                elif i + 3 < data_len and stream_data[i + 2] == 0 and stream_data[i + 3] == 1:
                    sc_len = 4

            if sc_len:
                start = i + sc_len
                j = start
                while j <= data_len - 4:
                    if (
                        stream_data[j] == 0 and stream_data[j + 1] == 0
                        and (
                            stream_data[j + 2] == 1
                            or (j + 3 < data_len and stream_data[j + 2] == 0 and stream_data[j + 3] == 1)
                        )
                    ):
                        break
                    j += 1
                spans.append((start, j))
                i = j
            else:
                i += 1
        return spans

    def _prepare_h264_stream_packet(self, stream_data):
        spans = self._find_nalu_spans(stream_data)
        if not spans:
            return stream_data

        has_idr = False
        has_sps = False
        has_pps = False

        for start, end in spans:
            if start >= end:
                continue
            nalu_type = stream_data[start] & 0x1F
            if nalu_type == 7:
                has_sps = True
                self._h264_sps = b'\x00\x00\x00\x01' + stream_data[start:end]
            elif nalu_type == 8:
                has_pps = True
                self._h264_pps = b'\x00\x00\x00\x01' + stream_data[start:end]
            elif nalu_type == 5:
                has_idr = True

        if not has_idr:
            return stream_data

        prefix = b''
        if not has_sps and self._h264_sps is not None:
            prefix += self._h264_sps
        if not has_pps and self._h264_pps is not None:
            prefix += self._h264_pps

        if prefix:
            if H264_PARAM_VERBOSE:
                print('[RTSP] IDR 前补发 SPS/PPS 参数集')
            return prefix + stream_data
        return stream_data

    def start(self):
        self._init_stream()
        self.rtspserver.rtspserver_init(self.port)
        self.rtspserver.rtspserver_createsession(self.session_name, self.video_type, self.enable_audio)
        self.rtspserver.rtspserver_start()
        self._start_stream()

        self.start_stream = True
        _thread.start_new_thread(self._do_rtsp_stream, ())

    def stop(self):
        if not self.start_stream:
            return
        self.start_stream = False
        while not self.runthread_over:
            sleep(0.1)
        self.runthread_over = False

        self._stop_stream()
        self.rtspserver.rtspserver_stop()
        self.rtspserver.rtspserver_deinit()
        # 由于开发板断开时容易出现 vb config failed(18) 这个是因为内存未被释放
        # 尝试使用 mm 级 deinit 一次，保证硬释放
        try:
            mm.kd_mpi_sys_mmz_free(0)
        except Exception:
            pass

    def get_rtsp_url(self):
        return self.rtspserver.rtspserver_getrtspurl(self.session_name)

    def _init_stream(self):
        width = 1280
        height = 720
        width = ALIGN_UP(width, 16)
        
        self.sensor = Sensor()
        self.sensor.reset()
        self.sensor.set_framesize(width=width, height=height, alignment=12)
        self.sensor.set_pixformat(Sensor.YUV420SP)
        
        self.encoder = Encoder()
        # 输出缓冲适度增大，缓解并发场景下的编码抖动；若失败则自动回退
        buf_candidates = (VENC_OUT_BUF_NUM, 16, 8)
        buf_selected = None
        for buf_num in buf_candidates:
            try:
                self.encoder.SetOutBufs(self.venc_chn, buf_num, width, height)
                buf_selected = buf_num
                break
            except Exception as e:
                print(f"[RTSP] SetOutBufs={buf_num} 失败: {e}")

        if buf_selected is None:
            raise RuntimeError("[RTSP] 编码输出缓冲配置失败")
        print(f"[RTSP] 编码输出缓冲数: {buf_selected}")
        self.link = MediaManager.link(self.sensor.bind_info()['src'], (VIDEO_ENCODE_MOD_ID, VENC_DEV_ID, self.venc_chn))
        
        # [修改点]: 还原为最初不需要显式传入 config_t 的默认方式
        # 在早期固件中，MediaManager.init 会自动计算池大小，不需要/不支持字典配置
        MediaManager.init()

        chnAttr = ChnAttrStr(self.encoder.PAYLOAD_TYPE_H264, self.encoder.H264_PROFILE_MAIN, width, height)
        self.encoder.Create(self.venc_chn, chnAttr)

    def _start_stream(self):
        self.encoder.Start(self.venc_chn)
        self.sensor.run()

    def _stop_stream(self):
        self.sensor.stop()
        del self.link
        self.encoder.Stop(self.venc_chn)
        self.encoder.Destroy(self.venc_chn)
        MediaManager.deinit()

    def _do_rtsp_stream(self):
        try:
            streamData = StreamData()
            while self.start_stream:
                os.exitpoint()
                # 使用短超时而不是完全非阻塞，避免空转抢占CPU
                ret = self.encoder.GetStream(self.venc_chn, streamData, GET_STREAM_TIMEOUT_MS)
                if ret != 0:
                    sleep(0)
                    continue
                
                try:
                    if streamData.pack_cnt <= 0:
                        continue
                    
                    for pack_idx in range(0, streamData.pack_cnt):
                        stream_data = bytes(uctypes.bytearray_at(streamData.data[pack_idx], streamData.data_size[pack_idx]))
                        stream_data = self._prepare_h264_stream_packet(stream_data)
                        try:
                            self.rtspserver.rtspserver_sendvideodata(
                                self.session_name,
                                stream_data,
                                len(stream_data),
                                RTSP_SEND_TIMEOUT_MS
                            )
                        except Exception as send_e:
                            if RTSP_SEND_VERBOSE:
                                print(f"[RTSP] 发送失败，已丢弃当前包: {send_e}")
                    
                    if RTSP_STATS_VERBOSE:
                        self._frame_count += 1
                        now = time.time()
                        if now - self._last_stats_time >= RTSP_STATS_INTERVAL_S:
                            fps = self._frame_count / (now - self._last_stats_time)
                            print(f"[RTSP] 推流性能: {fps:.1f} FPS")
                            self._frame_count = 0
                            self._last_stats_time = now
                finally:
                    # 无论发送是否异常都释放编码缓存，避免缓冲堆积导致后续卡死
                    self.encoder.ReleaseStream(self.venc_chn, streamData)

                sleep(0)
        except BaseException as e:
            print(f"Exception {e}")
        finally:
            self.runthread_over = True
            self.stop()

class PanTiltController:
    """二维云台舵机控制器，支持 2 路 PWM 输出 (50Hz) 控制角度 (0~180度)"""
    def __init__(self, pan_pin=42, pan_channel=0, tilt_pin=43, tilt_channel=1):
        # 频率50Hz对应周期20ms，占空比2.5%~12.5%对应0.5ms~2.5ms的高电平（0~180度）
        print(f"[PWM] 初始化二维云台，引脚 Pan={pan_pin}(Ch{pan_channel}), Tilt={tilt_pin}(Ch{tilt_channel})")
        
        # 兼容开发板当前固件版本：手动配置 FPIOA，并通过 channel ID 初始化 PWM
        fpioa = FPIOA()
        fpioa.set_function(pan_pin, fpioa.PWM0 + pan_channel)
        fpioa.set_function(tilt_pin, fpioa.PWM0 + tilt_channel)
        
        # 默认中间位置 90度 对应占空比 7%
        self.pan_pwm = PWM(pan_channel, freq=50, duty=7)
        self.tilt_pwm = PWM(tilt_channel, freq=50, duty=7)
        self._pan_duty = 7
        self._tilt_duty = 7
        self._last_log_time = 0.0
        self._lock = _thread.allocate_lock()

    def _log_if_needed(self, message):
        if not PAN_TILT_VERBOSE:
            return
        now = time.time()
        if now - self._last_log_time >= PAN_TILT_LOG_INTERVAL_S:
            print(message)
            self._last_log_time = now
    
    def set_angle(self, pan_angle=None, tilt_angle=None):
        self._lock.acquire()
        try:
            # [修改点] 优化PWM设置逻辑，仅在角度确实变化时才调用PWM.duty()，减少I/O操作
            if pan_angle is not None:
                pan_angle = max(0, min(180, float(pan_angle)))
                duty_percent = int((pan_angle / 180.0) * 10 + 2.5)
                if duty_percent != self._pan_duty:
                    try:
                        self.pan_pwm.duty(duty_percent)
                        self._pan_duty = duty_percent
                        self._log_if_needed(f"[PanTilt] Pan set to {pan_angle}° (duty {duty_percent}%)")
                    except Exception as e:
                        print(f"[PanTilt] Pan PWM error: {e}")

            if tilt_angle is not None:
                tilt_angle = max(0, min(180, float(tilt_angle)))
                duty_percent = int((tilt_angle / 180.0) * 10 + 2.5)
                if duty_percent != self._tilt_duty:
                    try:
                        self.tilt_pwm.duty(duty_percent)
                        self._tilt_duty = duty_percent
                        self._log_if_needed(f"[PanTilt] Tilt set to {tilt_angle}° (duty {duty_percent}%)")
                    except Exception as e:
                        print(f"[PanTilt] Tilt PWM error: {e}")
        finally:
            self._lock.release()

def udp_control_server(ip, pan_tilt, pt_state):
    udp_port = 8888
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(('0.0.0.0', udp_port))
    # [修改点] timeout 从 1.0s 改为 2.0s，降低 UDP 线程轮询频率，减少对 RTSP 推流线程的抢占
    s.settimeout(2.0)
    print("====================================")
    print(f"网络/UDP 控制接口就绪: {ip}:{udp_port}")
    print(f"发送 JSON 格式如: {{\"pan\": 90, \"tilt\": 45, \"auto\": 1}}")
    print(f"或纯文本格式如: pan:90,tilt:45,auto:0")
    print("====================================")
    
    while True:
        try:
            data, addr = s.recvfrom(1024)
            msg = data.decode('utf-8').strip()
            
            pan, tilt, auto_sweep = None, None, None
            try:
                # 尝试解析 JSON
                j = json.loads(msg)
                pan = j.get('pan')
                tilt = j.get('tilt')
                auto_sweep = j.get('auto')
            except Exception:
                # 回退：解析普通文本 "pan:90,tilt:45,auto:0"
                for part in msg.split(','):
                    if ':' in part:
                        k, v = part.split(':', 1)
                        if k.strip().lower() == 'pan': pan = float(v)
                        if k.strip().lower() == 'tilt': tilt = float(v)
                        if k.strip().lower() == 'auto': auto_sweep = int(v)
            
            if pan is not None or tilt is not None:
                pan_tilt.set_angle(pan, tilt)
                pt_state['last_time'] = time.time()
                
            if auto_sweep is not None:
                pt_state['auto_enabled'] = bool(auto_sweep)
                print(f"[PanTilt] 串口调试记录: 自动巡航标志位已修改为 {pt_state['auto_enabled']}")
                
        except socket.timeout:
            pass # 正常超时，继续循环
        except Exception as e:
            pass # 忽略其他异常

if __name__ == "__main__":
    os.exitpoint(os.EXITPOINT_ENABLE)
    
    # 1. 连接 Wi-Fi
    k230_ip = connect_wifi()
    if not k230_ip:
        print("网络无连接，程序退出。")
        sys.exit()

    # 2. 启动 RTSP 推流服务器 (路由名为 test)
    rtspserver = RtspServer(session_name="test", port=8554)
    rtspserver.start()
    
    rtsp_url = f"rtsp://{k230_ip}:8554/test"
    print("====================================")
    print(f"摄像推流已就绪, 请复制以下地址进行中继:")
    print(rtsp_url)
    print("====================================")

    pan_tilt = None
    pt_state = None

    # 3. 启动二维云台 PWM 舵机控制及监听接口
    if ENABLE_PAN_TILT:
        pan_tilt = PanTiltController(pan_pin=42, pan_channel=0, tilt_pin=43, tilt_channel=1)

        # 状态字典用于线程间共享：
        # `last_time` 记录上一次接到控制指令的时间；`auto_enabled` 是自动巡航的开关标志位
        pt_state = {'last_time': time.time() - 10.0, 'auto_enabled': AUTO_SWEEP_DEFAULT_ENABLED}
        _thread.start_new_thread(udp_control_server, (k230_ip, pan_tilt, pt_state))
    else:
        print("[PanTilt] 已禁用云台控制，仅运行 RTSP 推流")

    # 预设测试：平滑扫描模式
    sweep_angle = 0
    sweep_step = 5  # 每次增加的角度
    sweep_direction = 1 # 1为正向，-1为反向
    last_sweep_time = time.time()

    try:
        while True:
            # 缩短主循环 sleep 时长以提供平滑旋转
            time.sleep(0.1)
            os.exitpoint()
            
            if ENABLE_PAN_TILT and pan_tilt is not None and pt_state is not None:
                now = time.time()
                # 自动巡航逻辑：在开启了标志位，且距离最后一次接收到指令超过 5 秒（算作无人控制的空闲状态）
                if pt_state['auto_enabled'] and (now - pt_state['last_time'] > 5.0):
                    # 间隔 AUTO_SWEEP_INTERVAL_S 变化一次角度，降低控制线程开销
                    if now - last_sweep_time >= AUTO_SWEEP_INTERVAL_S:
                        pan_tilt.set_angle(pan_angle=sweep_angle, tilt_angle=sweep_angle)
                        # print(f"[扫描测试] 当前角度: {sweep_angle}")

                        sweep_angle += (sweep_step * sweep_direction)
                        if sweep_angle >= 180:
                            sweep_angle = 180
                            sweep_direction = -1
                        elif sweep_angle <= 0:
                            sweep_angle = 0
                            sweep_direction = 1

                        last_sweep_time = now
                    
    except KeyboardInterrupt:
        print("用户请求停止.")
    except Exception as e:
        print(f"程序异常退出: {e}")
    finally:
        rtspserver.stop()
        print("资源已释放。")