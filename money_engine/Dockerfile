FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p data output output/fleet output/site

ENV PORT=8000
ENV FLEET_TARGET_SIZE=50
ENV FLEET_AUTO_SCALE=true
ENV PUBLIC_BASE_URL=http://localhost:8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["sh", "entrypoint.sh"]
