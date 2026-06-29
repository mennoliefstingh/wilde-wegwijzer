FROM python:3.12-alpine

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATABASE_PATH=/data/wildewegwijzer.sqlite
ENV SEED_PATH=/app/seed/wilde-weide-2026.json

COPY . .

EXPOSE 8080

CMD ["python", "server.py"]
