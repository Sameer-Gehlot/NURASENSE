FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Default port 8080 (Railway will inject $PORT)
ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "exec uvicorn ecg_cloud_server:app --host 0.0.0.0 --port ${PORT:-8080}"]
