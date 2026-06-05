# SharePoint SPFx → Node API setup (HHHH)

Your workbench URL:

`https://hhhhteams.sharepoint.com/sites/HHHH/_layouts/15/workbench.aspx`

Browser **origin** for CORS: `https://hhhhteams.sharepoint.com`

---

## 1. Start Node API (this repo)

```bash
cd OMT-AI_backend_node
npm install
npm run dev
# or Docker:
./scripts/run-docker.sh
```

Verify:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/ping
```

---

## 2. CORS (implemented)

`.env`:

```env
CORS_ORIGINS=https://hhhhteams.sharepoint.com,https://localhost:4321
```

Test CORS headers:

```bash
curl -i -X OPTIONS http://localhost:3000/api/query \
  -H "Origin: https://hhhhteams.sharepoint.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type"
```

You should see `Access-Control-Allow-Origin: https://hhhhteams.sharepoint.com`.

---

## 3. Mixed content (HTTPS SharePoint → HTTP localhost)

The workbench is **HTTPS**. The browser **blocks** `http://localhost:3000` from an HTTPS page (mixed content). CORS alone does not fix this.

### Option A — ngrok (recommended for dev)

```bash
ngrok http 3000
```

Use the **https** URL in the web part, e.g. `https://abc123.ngrok-free.app` (no trailing slash).

Add ngrok origin to `.env` if needed:

```env
CORS_ORIGINS=https://hhhhteams.sharepoint.com,https://YOUR-ID.ngrok-free.app
```

### Option B — local gulp workbench only

`gulp serve` → `https://localhost:4321` can sometimes call `http://localhost:3000` if CORS is set (already in defaults).

### Option C — production

Deploy Node behind **HTTPS** (Azure App Service, VM + nginx, etc.) and set `apiBaseUrl` to that host.

---

## 4. Web part settings

| Property | Value |
|----------|--------|
| Enterprise AI API base URL | `https://YOUR-NGROK-ID.ngrok-free.app` or prod HTTPS URL |
| Not valid on SPO workbench | `http://localhost:3000` (mixed content) |

---

## 5. API endpoints for SPFx

| Call | Method | URL |
|------|--------|-----|
| Connection test | GET | `{apiBaseUrl}/api/ping` |
| Health | GET | `{apiBaseUrl}/health` |
| AI answer | POST | `{apiBaseUrl}/api/query` |

### POST /api/query

```json
{ "question": "Summarize HRMS status", "limit": 5 }
```

### SPFx fetch example

```typescript
const base = props.apiBaseUrl.replace(/\/$/, "");

const ping = await fetch(`${base}/api/ping`);
const data = await fetch(`${base}/api/query`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: userQuestion, limit: 5 }),
});
```

---

## 6. Checklist

| # | Check |
|---|--------|
| 1 | `curl http://localhost:3000/health` → 200 |
| 2 | CORS preflight with Origin `https://hhhhteams.sharepoint.com` → Allow-Origin header |
| 3 | Web part `apiBaseUrl` is **HTTPS** when page is SharePoint Online |
| 4 | `POST /api/query` works from terminal |
| 5 | F12 Network: `/api/query` not (failed) / not mixed-content |

---

## 7. F12 diagnosis

| Symptom | Fix |
|---------|-----|
| `ERR_CONNECTION_REFUSED` | Start Node / Docker |
| CORS error | Add exact origin to `CORS_ORIGINS`, restart API |
| Mixed content | Use ngrok HTTPS or deploy API with TLS |
| 404 | `apiBaseUrl` must not include `/api/query` — only base URL |
