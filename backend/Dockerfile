FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Build frontend and copy dist (run `npm run build` in frontend/ before docker build)
COPY ../frontend/dist ./frontend/dist 2>/dev/null || true

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
