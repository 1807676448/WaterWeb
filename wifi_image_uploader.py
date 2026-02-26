"""
wifi_image_uploader.py

用途：
  模拟“本地 WiFi 设备”向当前项目服务器上传图片。

协议：
  - HTTP 方法：POST
  - 默认路径：/upload
  - 请求体：图片二进制
  - 请求头：
      Content-Type: 根据扩展名推断
      X-File-Name: 服务端保存用文件名（必须是 HTTP 头可编码字符）
      X-Upload-Token: 可选，服务端开启鉴权时需要
      X-Description: 可选，图片说明（仅兼容 ASCII）
      X-Description-Encoded: 可选，UTF-8 + URL 编码后的图片说明（推荐）

为什么需要文件名“安全化”：
  Python 的 urllib/http.client 在发送 HTTP 头时按 latin-1 编码。
  如果 X-File-Name 含中文，会触发 UnicodeEncodeError，导致请求无法发出。
  因此这里会将文件名转换为 ASCII 安全名称后再放入请求头。
"""

import argparse
import json
import mimetypes
import os
import re
import socket
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
import unicodedata

DEFAULT_SERVER_BASE_URL = 'http://106.15.53.24:3000'


def choose_image_file():
  """弹出本地文件选择框，让用户选择图片。

  运行场景：
    - 桌面环境下，使用 tkinter 打开文件对话框。
    - 无图形界面（例如纯终端/远程环境）或 tkinter 不可用时，返回空字符串。

  返回：
    str：选中的文件路径；未选择或失败返回 ''。
  """
  try:
    import tkinter as tk
    from tkinter import filedialog

    # 创建隐藏根窗口，仅用于唤起文件选择框。
    root = tk.Tk()
    root.withdraw()
    root.update()

    # 仅引导选择常见图片类型。
    file_path = filedialog.askopenfilename(
      title='请选择要上传的图片',
      filetypes=[
        ('图片文件', '*.jpg *.jpeg *.png *.gif *.bmp *.webp'),
        ('所有文件', '*.*')
      ]
    )
    root.destroy()
    return file_path or ''
  except Exception:
    # 任何 GUI 相关异常都吞掉并回退为“未选择文件”。
    return ''


def build_upload_url(base_url, upload_path):
  """拼接服务端上传地址。

  处理细节：
    - 去掉 base_url 尾部多余 '/'
    - 保证 upload_path 以 '/' 开头
  """
  clean_base = base_url.rstrip('/')
  clean_path = upload_path if upload_path.startswith('/') else f'/{upload_path}'
  return f'{clean_base}{clean_path}'


def to_header_safe_filename(file_name):
  """将任意文件名转换为 HTTP 请求头可安全传输的文件名。

  背景：
    http.client.putheader 会把头值编码为 latin-1。
    非 latin-1 字符（如中文）会报 UnicodeEncodeError。

  转换规则：
    1) 取 basename，去除路径。
    2) 文件名主体做 NFKD 归一化并丢弃非 ASCII。
    3) 非 [a-zA-Z0-9._-] 字符统一替换为 '_'.
    4) 扩展名限制为 .[a-z0-9]{1,10}，否则降级为 .bin。
  """
  name = os.path.basename(file_name or '').strip()
  if not name:
    return 'image.bin'

  stem, ext = os.path.splitext(name)
  normalized = unicodedata.normalize('NFKD', stem)
  ascii_stem = normalized.encode('ascii', 'ignore').decode('ascii')
  ascii_stem = re.sub(r'[^a-zA-Z0-9._-]+', '_', ascii_stem).strip('._-')

  if not ascii_stem:
    ascii_stem = 'image'

  safe_ext = (ext or '.bin').lower()
  if not re.fullmatch(r'\.[a-z0-9]{1,10}', safe_ext):
    safe_ext = '.bin'

  safe_name = f'{ascii_stem}{safe_ext}'
  return safe_name


def upload_image(file_path, server_base_url, upload_path, token='', description='', timeout=20):
  """执行一次图片上传。

  参数：
    file_path: 本地图片路径
    server_base_url: 服务器基础地址，例如 http://127.0.0.1:3000
    upload_path: 上传接口路径，默认 /upload
    token: 上传令牌（可选）
    description: 图片说明（可选）
    timeout: 请求超时时间（秒）

  返回：
    dict: {
      status_code: HTTP 状态码,
      response_body: 响应文本,
      header_file_name: 发送到 X-File-Name 的实际值
    }
  """
  # 1) 基础文件校验
  if not os.path.isfile(file_path):
    raise FileNotFoundError(f'文件不存在: {file_path}')

  file_name = os.path.basename(file_path)
  # 请求头文件名必须是 ASCII 安全值，避免 latin-1 编码失败。
  header_file_name = to_header_safe_filename(file_name)

  # 2) 推断 Content-Type（仅用于 HTTP 头声明）
  content_type = mimetypes.guess_type(file_name)[0] or 'application/octet-stream'

  # 3) 读取图片二进制作为请求体
  with open(file_path, 'rb') as image_file:
    data = image_file.read()

  if not data:
    raise ValueError('图片内容为空')

  # 4) 组装请求头（与当前服务端协议一致）
  headers = {
    'Content-Type': content_type,
    'X-File-Name': header_file_name
  }
  if token:
    headers['X-Upload-Token'] = token
  if description:
    try:
      description.encode('latin-1')
      headers['X-Description'] = description
    except UnicodeEncodeError:
      pass

    headers['X-Description-Encoded'] = urllib.parse.quote(description, safe='')

  request = urllib.request.Request(
    build_upload_url(server_base_url, upload_path),
    data=data,
    headers=headers,
    method='POST'
  )

  # 5) 发起请求并返回响应
  with urllib.request.urlopen(request, timeout=timeout) as response:
    response_body = response.read().decode('utf-8', errors='replace')
    return {
      'status_code': response.getcode(),
      'response_body': response_body,
      'header_file_name': header_file_name
    }


def parse_args():
  """定义并解析命令行参数。"""
  parser = argparse.ArgumentParser(description='模拟本地 WiFi 设备上传图片到服务器')
  parser.add_argument('--file', help='本地图片路径；不传则弹窗选择')
  parser.add_argument('--server-base-url', default=DEFAULT_SERVER_BASE_URL, help=f'服务器基础地址（默认 {DEFAULT_SERVER_BASE_URL}）')
  parser.add_argument('--upload-path', default='/upload', help='上传接口路径（默认 /upload）')
  parser.add_argument('--token', default='', help='上传令牌，对应服务端 UPLOAD_TOKEN')
  parser.add_argument('--description', default='', help='图片说明；不传则上传前可交互输入')
  parser.add_argument('--timeout', type=int, default=20, help='HTTP 超时时间（秒）')
  return parser.parse_args()


def main():
  """程序主流程。

  返回码约定：
    0: 成功
    1: 未选择/未找到文件
    2: HTTP 层失败（4xx/5xx）
    3: 网络层失败（连接、DNS、超时等）
    4: 其他未分类异常
  """
  args = parse_args()

  # 优先使用 --file；未提供时尝试弹窗选择。
  image_path = args.file or choose_image_file()

  if not image_path:
    if args.file:
      print('未找到可上传文件，请检查 --file 路径。')
    else:
      print('未选择图片。若当前环境无法弹窗，请使用 --file 指定本地图片路径。')
    return 1

  print(f'准备上传: {image_path}')
  print(f'请求地址: {build_upload_url(args.server_base_url, args.upload_path)}')

  # 支持上传前交互输入图片说明：
  # - 传了 --description 则优先使用
  # - 未传时允许用户手动输入，直接回车表示不附带说明
  description = args.description
  if not description:
    try:
      user_input = input('请输入图片描述（可选，直接回车跳过）: ').strip()
      if user_input:
        description = user_input
    except (EOFError, KeyboardInterrupt):
      print('未输入图片描述，继续上传。')

  try:
    # 发起上传
    result = upload_image(
      file_path=image_path,
      server_base_url=args.server_base_url,
      upload_path=args.upload_path,
      token=args.token,
      description=description,
      timeout=args.timeout
    )

    print(f"HTTP {result['status_code']}")
    if result.get('header_file_name'):
      print(f"请求头文件名: {result['header_file_name']}")

    # 尝试按 JSON 美化输出；非 JSON 则原样打印。
    body = result['response_body']
    try:
      parsed = json.loads(body)
      print(json.dumps(parsed, ensure_ascii=False, indent=2))
    except Exception:
      print(body)
    return 0
  except urllib.error.HTTPError as error:
    # HTTPError 表示请求到了服务器，但返回了 4xx/5xx。
    error_body = error.read().decode('utf-8', errors='replace')
    print(f'上传失败: HTTP {error.code}')
    print(error_body)
    return 2
  except urllib.error.URLError as error:
    # URLError 主要是网络可达性问题（连接失败、域名解析失败等）。
    print(f'连接失败: {error.reason}')
    return 3
  except (TimeoutError, socket.timeout) as error:
    # 超时场景单独处理，便于快速判断是链路慢还是服务器响应慢。
    print(f'连接超时: {error}')
    print('建议：增大 --timeout（如 60/120），并检查服务器端口与防火墙策略。')
    return 3
  except Exception as error:
    # 兜底异常分支，打印堆栈便于定位。
    print(f'上传异常: {error}')
    traceback.print_exc()
    return 4


if __name__ == '__main__':
  # 不使用 sys.exit(...)，避免在 VS Code 调试器中显示 SystemExit 异常干扰。
  exit_code = main()
  if exit_code != 0:
    print(f'程序结束，返回码: {exit_code}')
