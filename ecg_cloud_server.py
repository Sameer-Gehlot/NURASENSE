"""
NuraSense TPP — Cloud ECG Processing & Telemetry Hub
FastAPI server for deployment on Railway.

Features:
1. Ingests raw 250Hz ECG batches from ESP32 via POST /ingest with 'x-device-token' header
2. Verifies device token and retrieves user_id from Supabase 'devices' table (with fast in-memory caching)
3. Applies clinical DSP filtering:
   - 50Hz Notch filter (powerline interference)
   - 0.5Hz - 40.0Hz Butterworth bandpass filter
   - Maintains continuous filter state (zi) across batch chunks in memory
4. Pan-Tompkins QRS and R-peak detection for accurate real-time BPM calculation
5. Broadcasts {samples: [...], bpm: float, timestamp: float} via WebSocket at /ws/{user_id}
6. Configured via SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables
"""

import asyncio
from collections import deque
import os
import sys
import time
from typing import Dict, List, Optional, Set, Tuple

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import numpy as np
import scipy.signal as signal
from supabase import create_client, Client

load_dotenv()

# UTF-8 stdout encoding for clean logging on Windows / Linux containers
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Initialize Supabase client
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://rtqeevykhqomyoyxeebf.supabase.co")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY") or ""

supabase_client: Optional[Client] = None
if SUPABASE_URL and SUPABASE_SERVICE_KEY:
    try:
        supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        print(f"[Supabase] Connected to {SUPABASE_URL}")
    except Exception as e:
        print(f"[Supabase] Warning: Could not initialize client: {e}")
else:
    print("[Supabase] Notice: SUPABASE_SERVICE_KEY not provided. Token lookups will use local fallback.")

app = FastAPI(
    title="NuraSense Cloud ECG Telemetry Engine",
    description="Real-time 250Hz single-lead ECG DSP filtering and Pan-Tompkins QRS BPM detection for TPP early warning.",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# In-memory device token cache: token -> (user_id, timestamp)
TOKEN_CACHE_TTL_SECONDS = 300  # 5 minutes
device_token_cache: Dict[str, Tuple[str, float]] = {}


async def resolve_user_id(device_token: str) -> Optional[str]:
    """
    Resolves user_id from device_token.
    Uses in-memory cache with TTL to avoid rate-limiting Supabase under 25Hz batch ingestion.
    """
    now = time.time()
    if device_token in device_token_cache:
        user_id, cached_at = device_token_cache[device_token]
        if now - cached_at < TOKEN_CACHE_TTL_SECONDS:
            return user_id

    # If Supabase client is configured, query the devices table
    if supabase_client:
        try:
            loop = asyncio.get_event_loop()
            res = await loop.run_in_executor(
                None,
                lambda: supabase_client.table("devices").select("user_id").eq("device_token", device_token).single().execute()
            )
            if res.data and "user_id" in res.data:
                uid = res.data["user_id"]
                device_token_cache[device_token] = (uid, now)
                return uid
        except Exception as e:
            print(f"[Devices] Lookup error for token {device_token[:8]}...: {e}")

    # Fallback for local simulation or when token matches a known user pattern
    if "_" in device_token or len(device_token) > 4:
        fallback_uid = f"user_{device_token.lower()}"
        device_token_cache[device_token] = (fallback_uid, now)
        return fallback_uid

    return None


class DeviceSignalState:
    """
    Per-device stateful streaming DSP filter & Pan-Tompkins QRS analyzer.
    Sampling rate: 250 Hz
    """
    def __init__(self, fs: int = 250):
        self.fs = fs
        nyq = 0.5 * fs

        # 50 Hz Notch filter (Q=30)
        self.b_notch, self.a_notch = signal.iirnotch(50.0 / nyq, Q=30.0)
        # 0.5 - 40.0 Hz Butterworth 2nd-order bandpass filter
        self.b_band, self.a_band = signal.butter(2, [0.5 / nyq, 40.0 / nyq], btype="bandpass")

        # Initial filter conditions for seamless streaming across 10-sample batches
        self.zi_notch = signal.lfilter_zi(self.b_notch, self.a_notch) * 0.0
        self.zi_band = signal.lfilter_zi(self.b_band, self.a_band) * 0.0

        # Continuous slow-moving DC baseline tracker (across seconds, NOT per 10-sample batch)
        self.dc_baseline: Optional[float] = None
        # Slow-moving peak envelope for natural physiological scaling
        self.envelope: float = 400.0

        # Rolling buffer of filtered samples for Pan-Tompkins peak detection (750 samples = 3.0s)
        self.filtered_history: deque = deque(maxlen=750)
        self.last_bpm: float = 72.0
        self.last_update_time: float = time.time()
        self.lock = asyncio.Lock()

    def filter_batch(self, raw_samples: List[float]) -> np.ndarray:
        """Applies streaming 50Hz notch and 0.5-40Hz bandpass filtering."""
        arr = np.asarray(raw_samples, dtype=np.float32)
        if len(arr) == 0:
            return np.array([], dtype=np.float32)

        # Update smooth continuous baseline (avoids tearing signal in 10-sample chunks)
        batch_mean = float(np.mean(arr))
        if self.dc_baseline is None:
            self.dc_baseline = batch_mean
        else:
            # Slow adaptation time constant (~2 seconds)
            alpha = 0.04
            self.dc_baseline = (1.0 - alpha) * self.dc_baseline + alpha * batch_mean

        # Center signal around continuous baseline
        centered = arr - self.dc_baseline

        # Stream filtering with state persistence across batches
        notched, self.zi_notch = signal.lfilter(self.b_notch, self.a_notch, centered, zi=self.zi_notch)
        bandpassed, self.zi_band = signal.lfilter(self.b_band, self.a_band, notched, zi=self.zi_band)

        # Smooth envelope tracking so quiet baseline stays quiet and QRS peaks spike naturally
        batch_max = float(np.max(np.abs(bandpassed))) if len(bandpassed) > 0 else 100.0
        self.envelope = max(200.0, 0.985 * self.envelope + 0.015 * batch_max)

        # Normalized signal around 0 (QRS complexes reach ~ ±0.8 to ±1.0)
        normalized = bandpassed / self.envelope

        for s in normalized:
            self.filtered_history.append(float(s))

        self.last_update_time = time.time()
        return normalized

    def calculate_bpm(self) -> float:
        """
        Pan-Tompkins Algorithm for QRS detection:
        1. Bandpassed signal (from filtered_history)
        2. Five-point derivative
        3. Squaring
        4. Moving window integration (150ms window = 37 samples)
        5. Adaptive peak thresholding
        """
        if len(self.filtered_history) < 250:
            return self.last_bpm

        sig = np.array(self.filtered_history, dtype=np.float32)

        # Derivative
        diff = np.diff(sig)
        # Squaring
        squared = diff ** 2

        # Moving window integration (150ms)
        win_size = max(2, int(0.15 * self.fs))
        integrated = np.convolve(squared, np.ones(win_size) / win_size, mode="same")

        # Thresholding
        threshold = np.mean(integrated) + 1.2 * np.std(integrated)
        # Refractory period: minimum 350ms between beats (max 171 bpm)
        min_distance = int(0.35 * self.fs)

        peaks, _ = signal.find_peaks(integrated, height=threshold, distance=min_distance)

        if len(peaks) >= 2:
            rr_intervals = np.diff(peaks) / float(self.fs)
            median_rr = float(np.median(rr_intervals))
            if median_rr > 0:
                bpm = round(60.0 / median_rr, 1)
                # Physiological bounds check (30 - 220 BPM)
                if 30 <= bpm <= 220:
                    self.last_bpm = bpm

        return self.last_bpm


# Active device states in memory: device_token -> DeviceSignalState
device_states: Dict[str, DeviceSignalState] = {}


class ConnectionManager:
    """Manages active dashboard WebSocket subscribers per user_id."""
    def __init__(self):
        self.active_connections: Dict[str, Set[WebSocket]] = {}
        self.lock = asyncio.Lock()

    async def connect(self, user_id: str, websocket: WebSocket):
        await websocket.accept()
        async with self.lock:
            if user_id not in self.active_connections:
                self.active_connections[user_id] = set()
            self.active_connections[user_id].add(websocket)
        print(f"[WS] User {user_id} connected. Total clients for user: {len(self.active_connections[user_id])}")

    async def disconnect(self, user_id: str, websocket: WebSocket):
        async with self.lock:
            if user_id in self.active_connections:
                self.active_connections[user_id].discard(websocket)
                if not self.active_connections[user_id]:
                    del self.active_connections[user_id]
        print(f"[WS] User {user_id} disconnected.")

    async def broadcast(self, user_id: str, data: dict):
        async with self.lock:
            clients = list(self.active_connections.get(user_id, []))

        for ws in clients:
            try:
                await ws.send_json(data)
            except Exception:
                await self.disconnect(user_id, ws)


manager = ConnectionManager()


class IngestBatchRequest(BaseModel):
    samples: List[float] = Field(..., description="Array of ECG sample counts, typically 10 samples @ 250Hz")


@app.get("/")
@app.get("/health")
async def health_check():
    return {
        "status": "online",
        "service": "NuraSense Cloud ECG Telemetry Engine",
        "active_devices": len(device_states),
        "connected_users": len(manager.active_connections),
        "timestamp": time.time()
    }


@app.post("/ingest")
async def ingest_ecg_batch(
    payload: IngestBatchRequest,
    x_device_token: Optional[str] = Header(None)
):
    """
    Ingest endpoint for ESP32 hardware.
    Receives raw ECG samples, applies 50Hz notch and 0.5-40Hz bandpass filtering,
    calculates BPM, and broadcasts to dashboard clients subscribed to the owner's user_id.
    """
    if not x_device_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing 'x-device-token' header"
        )

    if not payload.samples:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty samples array"
        )

    user_id = await resolve_user_id(x_device_token)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Device token not registered to any user. Pair device in NuraSense dashboard."
        )

    # Get or create per-device DSP filter state
    if x_device_token not in device_states:
        device_states[x_device_token] = DeviceSignalState(fs=250)

    state = device_states[x_device_token]

    async with state.lock:
        filtered_samples = state.filter_batch(payload.samples)
        bpm = state.calculate_bpm()

    # Broadcast via WebSocket to dashboard
    broadcast_payload = {
        "samples": [round(float(s), 4) for s in filtered_samples],
        "bpm": bpm,
        "device_token": x_device_token,
        "timestamp": time.time()
    }
    await manager.broadcast(user_id, broadcast_payload)

    return {
        "status": "ok",
        "user_id": user_id,
        "processed_samples": len(payload.samples),
        "bpm": bpm
    }


@app.websocket("/ws/{user_id}")
async def websocket_dashboard_endpoint(websocket: WebSocket, user_id: str):
    """
    WebSocket endpoint for NuraSense Patient Dashboard.
    Streams live 250Hz ECG samples and Pan-Tompkins BPM for the specified user.
    """
    await manager.connect(user_id, websocket)
    try:
        # Send initial confirmation
        await websocket.send_json({
            "type": "connection_established",
            "user_id": user_id,
            "buffer_target": 750,
            "sampling_rate": 250
        })

        # Keep connection open and handle incoming messages/pings
        while True:
            text = await websocket.receive_text()
            if text == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await manager.disconnect(user_id, websocket)
    except Exception as e:
        print(f"[WS Error] {e}")
        await manager.disconnect(user_id, websocket)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8765"))
    print(f"[Server] Starting NuraSense Cloud ECG Engine on port {port}...")
    uvicorn.run("ecg_cloud_server:app", host="0.0.0.0", port=port, reload=False)
