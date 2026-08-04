import 'dotenv/config';
import {
  parseSharePointSites,
  buildIngestSources,
  INGEST_LIST_KEYS,
} from './config/sharepointSites.js';

const sharePointSites = parseSharePointSites();
const ingestSources = buildIngestSources(sharePointSites);

const defaultCorsOrigins = [
  'https://hhhhteams.sharepoint.com',
  'https://localhost:4321',
  'http://localhost:4321',
];

function parseCorsOrigins() {
  const raw = process.env.CORS_ORIGINS;
  if (!raw) return defaultCorsOrigins;
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  cors: {
    origins: parseCorsOrigins(),
    allowLocalDev: process.env.CORS_ALLOW_LOCAL_DEV !== 'false',
  },
  /** ollama | local | huggingface */
  embeddings: {
    provider: process.env.EMBEDDING_PROVIDER || 'ollama',
    localModel:
      process.env.LOCAL_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
    chatModel: process.env.OLLAMA_CHAT_MODEL || 'llama3.2',
    maxTokens: Number(process.env.OLLAMA_MAX_TOKENS) || 1024,
    temperature: Number(process.env.OLLAMA_TEMPERATURE) || 0.3,
    maxPromptChars: Number(process.env.OLLAMA_MAX_PROMPT_CHARS) || 8000,
  },
  chat: {
    provider: process.env.CHAT_PROVIDER || 'ollama',
    /** Off by default — HF chat needs Inference Providers + supported model */
    fallbackToHf: process.env.CHAT_FALLBACK_HF === 'true',
  },
  huggingface: {
    apiKey: process.env.HUGGINGFACE_API_KEY || process.env.HF_API_KEY,
    embeddingModel:
      process.env.HF_EMBEDDING_MODEL || 'BAAI/bge-base-en-v1.5',
    chatModel:
      process.env.HF_CHAT_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3',
    maxTokens: Number(process.env.HF_MAX_TOKENS) || 1024,
    temperature: Number(process.env.HF_TEMPERATURE) || 0.3,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    /** flash-lite often has free-tier quota when gemini-2.0-flash is exhausted */
    chatModel: process.env.GEMINI_CHAT_MODEL || 'gemini-2.0-flash-lite',
    maxPromptChars: Number(process.env.GEMINI_MAX_PROMPT_CHARS) || 6000,
    maxRetries: Number(process.env.GEMINI_MAX_RETRIES) || 2,
  },
  /** Local Hermes CLI's OpenAI-compatible proxy (`hermes proxy start`), default port 8645 */
  hermes: {
    baseUrl: process.env.HERMES_BASE_URL || 'http://127.0.0.1:8645/v1',
    chatModel: process.env.HERMES_CHAT_MODEL || 'tencent/hy3:free',
    maxPromptChars: Number(process.env.HERMES_MAX_PROMPT_CHARS) || 8000,
  },
  /** "Gemini Flash" in the dropdown — actually Hugging Face's Inference Providers router, a
   *  non-reasoning model chosen for speed over the Nous-backed Hermes path. */
  hfFlash: {
    baseUrl: process.env.HF_FLASH_BASE_URL || 'https://router.huggingface.co/v1',
    apiKey: process.env.HUGGINGFACE_API_KEY || process.env.HF_API_KEY,
    chatModel: process.env.HF_FLASH_CHAT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct:together',
  },
  qdrant: {
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    collection: process.env.QDRANT_COLLECTION || 'enterprise_knowledge',
    /** 768 for nomic-embed-text (Ollama), 384 for all-MiniLM-L6-v2 */
    vectorSize: Number(process.env.VECTOR_SIZE) || 768,
  },
  sharepoint: {
    tenantId: process.env.TENANT_ID,
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    siteId: process.env.SHAREPOINT_SITE_ID,
    sites: sharePointSites,
    ingestSources,
    ingestListKeys: INGEST_LIST_KEYS,
    timeEntriesMonths: Number(process.env.TIMEENTRIES_MONTHS) || 3,
  },
};
