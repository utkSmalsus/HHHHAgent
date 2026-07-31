import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { ensureCollection } from './services/qdrant.js';
import { checkOllama } from './services/ollama.js';
import { corsMiddleware, corsPreflight } from './middleware/cors.js';
import ingestRoutes from './routes/ingest.js';
import searchRoutes from './routes/search.js';
import queryRoutes from './routes/query.js';
import meetingRoutes from './routes/meetings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(corsMiddleware);
corsPreflight(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function resolveEmbeddingModel() {
  if (config.embeddings.provider === 'ollama') return config.ollama.embedModel;
  if (config.embeddings.provider === 'local') return config.embeddings.localModel;
  return config.huggingface.embeddingModel;
}

function resolveChatModel() {
  if (config.chat.provider === 'ollama') return config.ollama.chatModel;
  if (config.chat.provider === 'huggingface') return config.huggingface.chatModel;
  return config.gemini.chatModel;
}

app.get('/', (_req, res) => res.redirect('/api/query/ui'));

app.get('/health', async (_req, res) => {
  const health = {
    status: 'ok',
    service: 'omt-ai-orchestration',
    embeddings: config.embeddings.provider,
    chat: config.chat.provider,
    embeddingModel: resolveEmbeddingModel(),
    chatModel: resolveChatModel(),
    ollamaUrl: config.ollama.baseUrl,
    corsOrigins: config.cors.origins,
  };

  if (config.embeddings.provider === 'ollama' || config.chat.provider === 'ollama') {
    health.ollama = await checkOllama();
  }

  res.json(health);
});

app.get('/api/ping', (_req, res) => {
  res.json({
    success: true,
    message: 'Node API reachable from SharePoint',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/ingest', ingestRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/query', queryRoutes);
app.use('/api/meetings', meetingRoutes);

async function start() {
  try {
    await ensureCollection();
    console.log(`Qdrant collection "${config.qdrant.collection}" ready (dim ${config.qdrant.vectorSize})`);
  } catch (err) {
    console.warn('Qdrant init warning:', err.message);
  }

  if (config.embeddings.provider === 'ollama' || config.chat.provider === 'ollama') {
    const ollama = await checkOllama();
    if (ollama.ok) {
      console.log(`Ollama connected: ${config.ollama.baseUrl}`);
      console.log(`  embed: ${config.ollama.embedModel} | chat: ${config.ollama.chatModel}`);
    } else {
      console.warn(`Ollama not reachable: ${ollama.error}`);
      console.warn('  Run: ollama serve && ./scripts/ollama-pull.sh');
    }
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Enterprise AI Orchestration Backend running on port ${config.port}`);
    console.log(
      `AI: ${config.embeddings.provider} embeddings + ${config.chat.provider} chat`
    );
    console.log('Query: POST /api/query | Ingest UI: /api/ingest/progress/ui');
  });
}

start();
