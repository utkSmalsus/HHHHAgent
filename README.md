# Enterprise AI Orchestration Backend

Central intelligence layer between **SharePoint**, **Qdrant**, and **Ollama** (or optional cloud AI) for enterprise project knowledge.

## Architecture

```
SPFx → Node.js → Qdrant + SharePoint → Ollama (embed + chat) → Response
```

## Running Locally (current setup — bundled Qdrant, no Docker)

This is how the project actually runs day-to-day: a bundled local Qdrant binary + Node + Ollama.

**One-time setup:**

```bash
nvm install 20          # this repo pins Node 20 via .nvmrc
ollama serve             # or open the Ollama app
./scripts/ollama-pull.sh # pulls nomic-embed-text + llama3.2
cp .env.example .env     # then fill in your SharePoint credentials
npm install
```

**Every time you want to run it** — two processes, each in its own terminal:

```bash
# Terminal 1 — Qdrant (vector DB)
cd .local/qdrant && ./qdrant

# Terminal 2 — the app (from the repo root)
nvm use && node src/index.js
```

Then open:

| What | URL |
|------|-----|
| Chat UI | http://localhost:3000/api/query/ui |
| Ingest / backup dashboard | http://localhost:3000/api/ingest/progress/ui |
| Health check | http://localhost:3000/health |
| Qdrant REST API (raw JSON) | http://localhost:6333/collections/enterprise_knowledge |

**Qdrant's visual dashboard is not available** on the bundled binary at `.local/qdrant/qdrant` — `/dashboard` 404s because this minimal build doesn't include the UI assets. To browse the vector data visually instead of via raw API JSON, install the full version separately:

```bash
brew install qdrant
```

That runs as a **separate** instance (different binary, different process) — it won't automatically see the data in `.local/qdrant/storage` unless you point it at that storage path.

## Ollama (recommended — local Mac)

No API keys or quotas. See **[docs/OLLAMA-SETUP.md](docs/OLLAMA-SETUP.md)**.

```bash
ollama serve                    # or open Ollama app
./scripts/ollama-pull.sh        # nomic-embed-text + llama3.2
```

```env
EMBEDDING_PROVIDER=ollama
CHAT_PROVIDER=ollama
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_CHAT_MODEL=llama3.2
VECTOR_SIZE=768
```

After switching embed models, run **`POST /api/ingest/all`** (progress UI: `/api/ingest/progress/ui`).

## Hugging Face models (optional)

| Purpose | Default model | Env override |
|---------|---------------|--------------|
| Embeddings (Qdrant) | `BAAI/bge-base-en-v1.5` (768 dims) | `HF_EMBEDDING_MODEL` |
| AI answers (RAG) | `mistralai/Mistral-7B-Instruct-v0.3` | `HF_CHAT_MODEL` |

Get a token: [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) → **Read** access.

```env
HUGGINGFACE_API_KEY=hf_xxxxxxxx
```

Optional faster/cheaper embedding (384 dims — set `VECTOR_SIZE=384` and recreate Qdrant collection):

```env
HF_EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
VECTOR_SIZE=384
```

## Quick Start

```bash
# 1. Start Qdrant
docker compose up -d

# 2. Configure environment
cp .env.example .env
# Edit .env with HUGGINGFACE_API_KEY and SharePoint credentials

# 3. Install & run
npm install
npm run dev
```

## Your list mapping (`.env`)

| Env variable | Used for | Ingest endpoint |
|--------------|----------|-----------------|
| `SP_TASKS` | Tasks | `POST /api/ingest/tasks` |
| `SP_MASTER_TASK` | Portfolio (same list) | `POST /api/ingest/portfolio` |
| `SP_MASTER_TASK` | Projects (same list) | `POST /api/ingest/projects` |
| `SP_TIMSHEET1` + `SP_TIMSHEET2` | Time entries (both merged) | `POST /api/ingest/timeentries` |
| `SHAREPOINT_SITE_ID` | Site for all lists above | — |

Config logic: `src/config/sharepointSites.js`

## Docker errors on Mac

### `docker-credential-desktop: executable file not found`

Docker is running but helper tools are not on your PATH. Fix once:

```bash
chmod +x scripts/fix-docker-path.sh
./scripts/fix-docker-path.sh
```

Or add to `~/.zshrc` and restart Terminal:

```bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
```

Then (or use the helper script):

```bash
./scripts/run-docker.sh
# same as: export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" && docker compose up -d --build
```

### `docker: command not found`

Same fix as above, or run:

```bash
/Applications/Docker.app/Contents/Resources/bin/docker compose up -d --build
```

### Java messages on terminal login

`Unable to locate a Java Runtime` comes from your shell profile (`.zshrc`), not this Node project. Install Java if you need it:

```bash
brew install openjdk@17
```

Or remove the Java-related lines from `~/.zshrc` if you do not use Java.

### Run without Docker (Homebrew Qdrant + Node)

```bash
brew install qdrant    # one-time
qdrant &               # starts on :6333
# Add HUGGINGFACE_API_KEY to .env
npm install
npm run dev            # API on :3000

# In another terminal:
npm run ingest
```

## Docker (Qdrant + Node API)

```bash
# Add HUGGINGFACE_API_KEY to .env first
docker compose up -d --build

# Verify mapping
curl http://localhost:3000/api/ingest/config

# Ingest all lists into Qdrant (background job)
curl -X POST http://localhost:3000/api/ingest/all

# Watch progress bar in terminal
npm run ingest:watch

# Or visual progress in browser
open http://localhost:3000/api/ingest/progress/ui

# Or poll JSON progress
curl http://localhost:3000/api/ingest/progress
```

Docker sets `QDRANT_URL=http://qdrant:6333` automatically for the API container.

### Ingest progress

| Endpoint | Description |
|----------|-------------|
| `GET /api/ingest/progress` | `percent`, `progressBar`, `processed/total`, per-list status |
| `GET /api/ingest/progress/stream` | Live SSE updates |
| `GET /api/ingest/progress/ui` | HTML progress bar page |

## SharePoint → Qdrant ingestion API

Base URL: `http://localhost:3000` (or your deployed host)

### Step 1 — Connect SharePoint (one-time setup)

1. **Azure App Registration** (Microsoft Entra)
   - Create an app → **Certificates & secrets** → new client secret
   - **API permissions** → Microsoft Graph → Application:
     - `Sites.Read.All`
     - `Sites.ReadWrite.All` (if lists are private)
   - Grant admin consent

2. **`.env` values — multiple sites (HHHH + HHHHQA)**

Register **each site** once, then point **each list** at the right site:

```env
TENANT_ID=<azure-tenant-id>
CLIENT_ID=<app-client-id>
CLIENT_SECRET=<app-client-secret>

# Site aliases → Graph site IDs
SP_SITE_HHHH=<graph-site-id-for-HHHH>
SP_SITE_HHHHQA=<graph-site-id-for-HHHHQA>

# Projects from HHHH, Tasks from HHHHQA (example — adjust to your setup)
SP_LIST_PROJECTS_SITE=HHHH
SP_LIST_PROJECTS=<projects-list-guid>

SP_LIST_TASKS_SITE=HHHHQA
SP_LIST_TASKS=<tasks-list-guid>

SP_LIST_TIME_ENTRIES_SITE=HHHH
SP_LIST_TIME_ENTRIES=<timeentries-list-guid>

SP_LIST_DOCUMENTS_SITE=HHHHQA
SP_LIST_DOCUMENTS=<documents-list-guid>

HUGGINGFACE_API_KEY=<required-for-embeddings-and-chat>
HF_EMBEDDING_MODEL=BAAI/bge-base-en-v1.5
HF_CHAT_MODEL=mistralai/Mistral-7B-Instruct-v0.3
QDRANT_URL=http://localhost:6333
```

Mapping is defined in `src/config/sharepointSites.js`.

3. **Get each site ID** (Graph Explorer):

```bash
GET https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/HHHH
GET https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/HHHHQA
# Use response "id" for SP_SITE_HHHH and SP_SITE_HHHHQA
```

4. **Get list IDs per site**:

```bash
GET https://graph.microsoft.com/v1.0/sites/{SP_SITE_HHHH}/lists
GET https://graph.microsoft.com/v1.0/sites/{SP_SITE_HHHHQA}/lists
```

5. **Verify mapping** (no secrets returned):

```bash
GET http://localhost:3000/api/ingest/config
```

### Step 2 — Ingestion endpoints

| Method | Endpoint | What it does |
|--------|----------|--------------|
| `GET` | `/health` | Server health check |
| `GET` | `/api/ingest/config` | Show HHHH / HHHHQA site mapping per list |
| `POST` | `/api/ingest/projects` | SharePoint Projects list → HF embeddings → Qdrant |
| `POST` | `/api/ingest/tasks` | SharePoint Tasks list → Qdrant |
| `POST` | `/api/ingest/timeentries` | SharePoint Time Entries list → Qdrant |
| `POST` | `/api/ingest/documents` | SharePoint Documents list → Qdrant |
| `GET` | `/api/ingest/progress` | Live ingest progress (JSON + progress bar) |
| `GET` | `/api/ingest/progress/ui` | Visual progress bar in browser |
| `POST` | `/api/ingest/all` | Ingest all lists (background, use progress endpoints) |

**No request body** when SharePoint is configured — the server calls Microsoft Graph, converts each row to text, embeds with Hugging Face, and stores in `enterprise_knowledge`.

### Step 3 — Call from SPFx, Postman, or curl

**Ingest one list:**

```bash
curl -X POST http://localhost:3000/api/ingest/projects \
  -H "Content-Type: application/json"
```

**Ingest everything:**

```bash
curl -X POST http://localhost:3000/api/ingest/all \
  -H "Content-Type: application/json"
```

**SPFx / fetch example:**

```javascript
const API_BASE = "https://your-node-server.com";

await fetch(`${API_BASE}/api/ingest/all`, { method: "POST" });
```

### Success response

```json
{
  "success": true,
  "type": "projects",
  "ingested": 12,
  "points": [
    {
      "id": "uuid",
      "payload": {
        "type": "project",
        "projectId": "P001",
        "projectName": "Time Entry Tool",
        "text": "Time Entry Tool. Status: Active. Completion: 80%. Owner: Ram",
        "timestamp": "2026-06-03",
        "sharePointSite": "HHHH",
        "sharePointItemId": "3"
      }
    }
  ]
}
```

**Bulk (`/api/ingest/all`) response:**

```json
{
  "success": true,
  "totalIngested": 45,
  "results": {
    "projects": { "ingested": 5, "points": [] },
    "tasks": { "ingested": 20, "points": [] },
    "timeentries": { "ingested": 15, "points": [] },
    "documents": { "ingested": 5, "points": [] }
  }
}
```

### Error responses

| Status | Meaning |
|--------|---------|
| `500` + `SharePoint auth failed` | Wrong `TENANT_ID` / `CLIENT_ID` / `CLIENT_SECRET` |
| `500` + `SharePoint list fetch failed` | Wrong `SHAREPOINT_SITE_ID` or `SP_LIST_*` |
| `200` + `ingested: 0` + not configured message | Missing SharePoint env vars |
| `500` + Qdrant/HF errors | Qdrant not running or missing `HUGGINGFACE_API_KEY` |

### Ingestion flow (server-side)

```
POST /api/ingest/{list}
    → Microsoft Graph (client credentials token)
    → GET /sites/{siteId}/lists/{listName}/items?expand=fields
    → Convert fields → readable text
    → Hugging Face feature-extraction (embeddings)
    → Qdrant upsert(enterprise_knowledge)
```

### SharePoint columns mapped automatically

| SharePoint field | Used in Qdrant text / payload |
|------------------|-------------------------------|
| `Title`, `ProjectName`, `Name` | Title / projectName |
| `Status`, `ProjectStatus` | Status line |
| `PercentComplete`, `Completion`, `Progress` | Completion % |
| `Owner`, `AssignedTo`, `ProjectOwner` | Owner |
| `Blockers`, `Risks` | Blockers |
| `Description`, `Body`, `Notes` | Extra context |
| `ProjectId`, `ProjectID` | projectId metadata |

### Manual ingest (without SharePoint)

Use when testing or SharePoint is not wired yet:

```bash
curl -X POST http://localhost:3000/api/ingest/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{
      "text": "Time Entry Tool is 80% complete. Ram fixing login bug.",
      "metadata": { "projectId": "P001", "projectName": "Time Entry Tool" }
    }]
  }'
```

## SharePoint SPFx (HHHH workbench)

Workbench: `https://hhhhteams.sharepoint.com/sites/HHHH/_layouts/15/workbench.aspx`

**CORS** is enabled for `https://hhhhteams.sharepoint.com` (see `CORS_ORIGINS` in `.env`).

**Important:** SharePoint is HTTPS — the browser blocks `http://localhost:3000` (mixed content). Use **ngrok** or a deployed HTTPS API as `apiBaseUrl` in the web part.

Full guide: [docs/SHAREPOINT-SPFx-SETUP.md](docs/SHAREPOINT-SPFx-SETUP.md)

```bash
# Connection test from browser / SPFx
GET  {apiBaseUrl}/api/ping
POST {apiBaseUrl}/api/query
```

```bash
ngrok http 3000
# Web part apiBaseUrl = https://xxxx.ngrok-free.app
```

## Other APIs

### Search (RAG)

```bash
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "login bug status", "limit": 5}'
```

### Main AI Query (SPFx)

```bash
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the status of Time Entry Tool?"}'
```

## Qdrant Collection

**Collection:** `enterprise_knowledge`

**Payload:**

```json
{
  "type": "project",
  "projectId": "P001",
  "projectName": "Time Entry Tool",
  "text": "Project is 80% complete. Ram working on bugs.",
  "timestamp": "2026-06-03"
}
```

## Environment Variables

See `.env.example` for all required keys.

## Project Structure

```
src/
  config.js
  config/sharepointSites.js   ← multi-site HHHH / HHHHQA mapping
  index.js
  prompts/enterpriseQuery.js
  routes/
    ingest.js
    search.js
    query.js
  services/
    huggingface.js
    ai.js
    qdrant.js
    sharepoint.js
    ingestion.js
```
