"""
NuraSense TPP — Primary Cloud Application Entrypoint
Exposes FastAPI app for Railway / Railpack / Uvicorn automatic discovery.
"""

import os
import uvicorn
from ecg_cloud_server import app

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    print(f"[NuraSense] Launching Cloud ECG Telemetry Engine on 0.0.0.0:{port}...")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)

