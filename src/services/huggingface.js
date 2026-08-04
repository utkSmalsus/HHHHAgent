import { HfInference } from '@huggingface/inference';
import { config } from '../config.js';

let client;

function getClient() {
  if (!client) {
    if (!config.huggingface.apiKey) {
      throw new Error('HUGGINGFACE_API_KEY is not configured');
    }
    client = new HfInference(config.huggingface.apiKey);
  }
  return client;
}

function normalizeEmbedding(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Hugging Face returned empty embedding');
  }

  if (typeof raw[0] === 'number') {
    return raw;
  }

  if (Array.isArray(raw[0]) && typeof raw[0][0] === 'number') {
    const tokens = raw;
    const dim = tokens[0].length;
    const mean = new Array(dim).fill(0);
    for (const token of tokens) {
      for (let i = 0; i < dim; i++) mean[i] += token[i];
    }
    return mean.map((v) => v / tokens.length);
  }

  throw new Error('Unexpected embedding shape from Hugging Face');
}

async function withRetry(fn, maxAttempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = String(err.message || err);
      const retryable =
        msg.includes('loading') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('blob');
      if (!retryable || attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
}

async function embedViaRouterApi(text, { isQuery = false } = {}) {
  const model = config.huggingface.embeddingModel;
  let truncated = text.slice(0, 8000);
  if (model.toLowerCase().includes('bge')) {
    truncated = `${isQuery ? 'query' : 'passage'}: ${truncated}`;
  }

  const url = `https://router.huggingface.co/hf-inference/models/${model}/pipeline/feature-extraction`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.huggingface.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs: truncated }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HF router ${res.status}: ${body.slice(0, 200)}`);
  }

  return normalizeEmbedding(JSON.parse(body));
}

export async function embedText(text, options = {}) {
  // No truncation here — services/ai.js rejects oversized input before it reaches any provider.
  let truncated = String(text ?? '');
  const model = config.huggingface.embeddingModel;
  if (model.toLowerCase().includes('bge')) {
    truncated = `${options.isQuery ? 'query' : 'passage'}: ${truncated}`;
  }

  try {
    const hf = getClient();
    const raw = await withRetry(() =>
      hf.featureExtraction({
        model,
        inputs: truncated,
        provider: 'hf-inference',
      })
    );
    return normalizeEmbedding(raw);
  } catch (sdkErr) {
    if (!String(sdkErr.message).includes('blob')) {
      throw new Error(
        `${sdkErr.message}. Enable HF Inference Providers: https://huggingface.co/settings/inference-providers`
      );
    }
    console.warn('HF SDK blob error, trying router API directly…');
    try {
      return await withRetry(() => embedViaRouterApi(text, options));
    } catch (routerErr) {
      throw new Error(
        `${routerErr.message}. Enable HF Inference Providers: https://huggingface.co/settings/inference-providers`
      );
    }
  }
}

