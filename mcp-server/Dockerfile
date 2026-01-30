FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server code
COPY server.py .

# Create non-root user
RUN useradd -m -s /bin/bash appuser
USER appuser

# Environment variables
ENV MCP_PORT=3002
ENV API_BASE_URL=http://wago-webvisu-adapter:8080

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:3002/health').raise_for_status()"

CMD ["python", "server.py"]
