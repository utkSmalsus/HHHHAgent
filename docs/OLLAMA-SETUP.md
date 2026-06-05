# Ollama setup (local AI + embeddings)

No Gemini quota, no Hugging Face Inference Providers — everything runs on your Mac via **Ollama**.

## 1. Install & start Ollama

Already installed? Just ensure it is running:

```bash
ollama serve
```

Or open the **Ollama** app (menu bar icon = running).

## 2. Pull models (one-time)

```bash
cd /Users/anubhav/Desktop/OMT-AI_backend_node
chmod +x scripts/ollama-pull.sh
./scripts/ollama-pull.sh
```

| Model | Use | Size (approx) |
|-------|-----|----------------|
| `nomic-embed-text` | Embeddings → Qdrant | ~274 MB |
| `llama3.2` | Chat answers | ~2 GB |

### Other good chat models (optional)

```bash
ollama pull llama3.1:8b      # stronger, slower
ollama pull mistral          # alternative
ollama pull qwen2.5:7b       # strong reasoning
```

Set in `.env`:

```env
OLLAMA_CHAT_MODEL=llama3.1:8b
```

## 3. `.env` (already configured)

```env
EMBEDDING_PROVIDER=ollama
CHAT_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_CHAT_MODEL=llama3.2
VECTOR_SIZE=768
```

**Docker:** `OLLAMA_BASE_URL` is overridden to `http://host.docker.internal:11434` in `docker-compose.yml`.

## 4. Start stack

```bash
docker compose up -d --build
```

Or without Docker:

```bash
npm run dev
```

## 5. Re-ingest (required after switching embed model)

Vector size changed from 384 → 768. Run full ingest:

```bash
open http://localhost:3000/api/ingest/progress/ui
# Click "Start full ingest"
```

Or:

```bash
curl -X POST http://localhost:3000/api/ingest/all
```

## 6. Test

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"question":"Give update on HRMS tool","limit":5}'
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| Cannot reach Ollama | `ollama serve` or open Ollama app |
| model not found | `./scripts/ollama-pull.sh` |
| Docker can't reach Ollama | Ollama must run on **host**; use Docker compose `host.docker.internal` |
| Slow first query | Model loading — normal; later queries faster |
