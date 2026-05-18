"""
K230 RTSP Debug Viewer (LAN)

Purpose:
- Pull RTSP stream from K230 in LAN
- Show live video on PC with GUI
- Help debugging stream stability and quality

Dependencies:
- opencv-python
- pillow

Run:
  python tools/k230_rtsp_debug_viewer.py --url rtsp://192.168.137.52:8554/test
"""

import argparse
import os
import queue
import threading
import time
from datetime import datetime

import cv2
import tkinter as tk
from tkinter import ttk, messagebox

try:
    from PIL import Image, ImageTk
except ImportError as exc:
    raise SystemExit(
        "Missing dependency: pillow. Install with: pip install pillow"
    ) from exc


class RTSPDebugViewer:
    def __init__(self, root: tk.Tk, initial_url: str):
        self.root = root
        self.root.title("K230 RTSP Debug Viewer")
        self.root.geometry("1100x760")
        self.root.minsize(900, 620)

        self.url_var = tk.StringVar(value=initial_url)
        self.status_var = tk.StringVar(value="Idle")
        self.fps_var = tk.StringVar(value="FPS: 0.0")
        self.resolution_var = tk.StringVar(value="Resolution: -")
        self.frames_var = tk.StringVar(value="Frames: 0")
        self.errors_var = tk.StringVar(value="ReadErrors: 0")

        self.capture = None
        self.reader_thread = None
        self.stop_event = threading.Event()
        self.frame_queue = queue.Queue(maxsize=2)
        self.display_job = None

        self.running = False
        self.last_frame_bgr = None
        self._photo_ref = None

        self.frame_count = 0
        self.read_error_count = 0
        self._fps_counter = 0
        self._fps_last_t = time.time()

        self._build_ui()
        self._schedule_display_loop()

    def _build_ui(self):
        control = ttk.Frame(self.root, padding=10)
        control.pack(side=tk.TOP, fill=tk.X)

        ttk.Label(control, text="RTSP URL:").grid(row=0, column=0, sticky="w")
        url_entry = ttk.Entry(control, textvariable=self.url_var, width=90)
        url_entry.grid(row=0, column=1, columnspan=5, sticky="ew", padx=(6, 8))

        self.start_btn = ttk.Button(control, text="Start", command=self.start_stream)
        self.start_btn.grid(row=0, column=6, padx=4)

        self.stop_btn = ttk.Button(control, text="Stop", command=self.stop_stream, state=tk.DISABLED)
        self.stop_btn.grid(row=0, column=7, padx=4)

        self.reconnect_btn = ttk.Button(control, text="Reconnect", command=self.reconnect_stream)
        self.reconnect_btn.grid(row=0, column=8, padx=4)

        self.snapshot_btn = ttk.Button(control, text="Snapshot", command=self.save_snapshot)
        self.snapshot_btn.grid(row=0, column=9, padx=4)

        control.columnconfigure(1, weight=1)

        status_bar = ttk.Frame(self.root, padding=(10, 0, 10, 8))
        status_bar.pack(side=tk.TOP, fill=tk.X)

        ttk.Label(status_bar, textvariable=self.status_var, foreground="#004f9f").pack(side=tk.LEFT, padx=(0, 14))
        ttk.Label(status_bar, textvariable=self.fps_var).pack(side=tk.LEFT, padx=(0, 14))
        ttk.Label(status_bar, textvariable=self.resolution_var).pack(side=tk.LEFT, padx=(0, 14))
        ttk.Label(status_bar, textvariable=self.frames_var).pack(side=tk.LEFT, padx=(0, 14))
        ttk.Label(status_bar, textvariable=self.errors_var).pack(side=tk.LEFT)

        video_frame = ttk.Frame(self.root, padding=(10, 0, 10, 10))
        video_frame.pack(side=tk.TOP, fill=tk.BOTH, expand=True)

        self.video_label = ttk.Label(video_frame, text="No video", anchor="center", background="#1f1f1f", foreground="#ffffff")
        self.video_label.pack(fill=tk.BOTH, expand=True)

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def _set_status(self, text: str):
        self.status_var.set(text)

    def _set_running_ui(self, running: bool):
        self.start_btn.configure(state=tk.DISABLED if running else tk.NORMAL)
        self.stop_btn.configure(state=tk.NORMAL if running else tk.DISABLED)

    def _reset_counters(self):
        self.frame_count = 0
        self.read_error_count = 0
        self._fps_counter = 0
        self._fps_last_t = time.time()
        self.frames_var.set("Frames: 0")
        self.errors_var.set("ReadErrors: 0")
        self.fps_var.set("FPS: 0.0")

    def start_stream(self):
        if self.running:
            return

        url = self.url_var.get().strip()
        if not url:
            messagebox.showerror("Input Error", "RTSP URL is empty.")
            return

        self._reset_counters()
        self.stop_event.clear()
        self.running = True
        self._set_running_ui(True)
        self._set_status("Connecting...")

        self.reader_thread = threading.Thread(target=self._reader_loop, args=(url,), daemon=True)
        self.reader_thread.start()

    def stop_stream(self):
        if not self.running:
            return

        self.stop_event.set()

        if self.reader_thread and self.reader_thread.is_alive():
            self.reader_thread.join(timeout=2.0)

        self.reader_thread = None
        self.running = False
        self._set_running_ui(False)
        self._set_status("Stopped")

        if self.capture is not None:
            self.capture.release()
            self.capture = None

    def reconnect_stream(self):
        was_running = self.running
        self.stop_stream()
        if was_running:
            time.sleep(0.2)
        self.start_stream()

    def _open_capture(self, url: str):
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        if not cap.isOpened():
            cap.release()
            cap = cv2.VideoCapture(url)

        if cap.isOpened():
            # Hint decoder to keep latency low when backend supports it.
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def _reader_loop(self, url: str):
        try:
            self.capture = self._open_capture(url)
            if self.capture is None or (not self.capture.isOpened()):
                self.root.after(0, lambda: self._handle_stream_error("Failed to open RTSP stream"))
                return

            self.root.after(0, lambda: self._set_status("Streaming"))

            while not self.stop_event.is_set():
                ok, frame = self.capture.read()
                if not ok or frame is None:
                    self.read_error_count += 1
                    self.root.after(0, lambda: self.errors_var.set(f"ReadErrors: {self.read_error_count}"))
                    time.sleep(0.03)
                    continue

                self.last_frame_bgr = frame
                self.frame_count += 1
                self._fps_counter += 1

                now = time.time()
                dt = now - self._fps_last_t
                if dt >= 1.0:
                    fps = self._fps_counter / dt
                    self._fps_counter = 0
                    self._fps_last_t = now
                    self.root.after(0, lambda f=fps: self.fps_var.set(f"FPS: {f:.1f}"))

                self.root.after(0, lambda c=self.frame_count: self.frames_var.set(f"Frames: {c}"))

                h, w = frame.shape[:2]
                self.root.after(0, lambda ww=w, hh=h: self.resolution_var.set(f"Resolution: {ww}x{hh}"))

                # Keep only latest frame in queue for smoother real-time preview.
                if self.frame_queue.full():
                    try:
                        self.frame_queue.get_nowait()
                    except queue.Empty:
                        pass

                try:
                    self.frame_queue.put_nowait(frame)
                except queue.Full:
                    pass
        except Exception as exc:
            self.root.after(0, lambda e=exc: self._handle_stream_error(f"Stream error: {e}"))
        finally:
            if self.capture is not None:
                self.capture.release()
                self.capture = None

            if self.running and self.stop_event.is_set():
                self.root.after(0, lambda: self._set_status("Stopped"))

    def _handle_stream_error(self, msg: str):
        self._set_status(msg)
        self.stop_stream()

    def _schedule_display_loop(self):
        self._display_latest_frame()
        self.display_job = self.root.after(15, self._schedule_display_loop)

    def _display_latest_frame(self):
        if not self.running:
            return

        latest = None
        while True:
            try:
                latest = self.frame_queue.get_nowait()
            except queue.Empty:
                break

        if latest is None:
            return

        bgr = latest
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

        label_w = max(100, self.video_label.winfo_width())
        label_h = max(100, self.video_label.winfo_height())

        h, w = rgb.shape[:2]
        scale = min(label_w / w, label_h / h)
        new_w = max(1, int(w * scale))
        new_h = max(1, int(h * scale))

        resized = cv2.resize(rgb, (new_w, new_h), interpolation=cv2.INTER_AREA)
        img = Image.fromarray(resized)
        photo = ImageTk.PhotoImage(image=img)

        self._photo_ref = photo
        self.video_label.configure(image=photo, text="")

    def save_snapshot(self):
        if self.last_frame_bgr is None:
            messagebox.showwarning("Snapshot", "No frame available.")
            return

        out_dir = os.path.join(os.path.dirname(__file__), "snapshots")
        os.makedirs(out_dir, exist_ok=True)

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_path = os.path.join(out_dir, f"k230_snapshot_{ts}.jpg")

        ok = cv2.imwrite(out_path, self.last_frame_bgr)
        if not ok:
            messagebox.showerror("Snapshot", "Failed to save snapshot.")
            return

        self._set_status(f"Snapshot saved: {out_path}")

    def on_close(self):
        self.stop_stream()
        if self.display_job is not None:
            try:
                self.root.after_cancel(self.display_job)
            except Exception:
                pass
        self.root.destroy()


def main():
    parser = argparse.ArgumentParser(description="K230 RTSP LAN debug viewer with GUI")
    parser.add_argument(
        "--url",
        default="rtsp://192.168.137.52:8554/test",
        help="K230 RTSP URL in LAN",
    )
    args = parser.parse_args()

    root = tk.Tk()
    app = RTSPDebugViewer(root, args.url)
    app.start_stream()
    root.mainloop()


if __name__ == "__main__":
    main()
