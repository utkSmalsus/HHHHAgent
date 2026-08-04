import { config } from '../config.js';
import {
  INSUFFICIENT_DATA_MESSAGE,
  sanitizeEnterpriseAnswer,
  normalizePlainBusinessAnswer,
} from '../utils/answerSanitizer.js';

async function ollamaFetch(path, body, timeoutMs = 300000, externalSignal) {
  const url = `${config.ollama.baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Client stopped generation (or disconnected) — cancel the in-flight Ollama request too,
  // instead of letting it run to completion for an answer nobody will see.
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Ollama ${path} ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new Error('Stopped by user.');
      }
      throw new Error(`Ollama request timed out (${timeoutMs / 1000}s). Is Ollama running?`);
    }
    if (String(err.cause || err.message).includes('ECONNREFUSED')) {
      throw new Error(
        `Cannot reach Ollama at ${config.ollama.baseUrl}. Run: ollama serve — and pull models (see README).`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

export async function checkOllama() {
  try {
    const res = await fetch(`${config.ollama.baseUrl}/api/tags`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data.models || []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function embedText(text) {
  // No truncation here: oversized input is rejected up front by services/ai.js (the single entry
  // point every caller routes through), so anything arriving here is already a bounded chunk.
  const input = String(text ?? '');

  try {
    const data = await ollamaFetch(
      '/api/embed',
      { model: config.ollama.embedModel, input },
      120000
    );
    const embedding = data.embeddings?.[0];
    if (embedding?.length) return embedding;
  } catch (err) {
    if (!String(err.message).includes('404')) throw err;
  }

  const legacy = await ollamaFetch(
    '/api/embeddings',
    { model: config.ollama.embedModel, prompt: input },
    120000
  );
  const embedding = legacy.embedding;
  if (!embedding?.length) {
    throw new Error('Ollama returned empty embedding');
  }
  return embedding;
}

export async function generateAnswer(promptOrMessages, { signal } = {}) {
  const isObject = promptOrMessages && typeof promptOrMessages === 'object';
  const system = isObject
    ? String(promptOrMessages.system || '').slice(0, 4000)
    : 'You are an enterprise project intelligence assistant. Use only the context in the user message. Be concise and factual. Never invent data.';
  const user = isObject
    ? String(promptOrMessages.user || '').slice(0, config.ollama.maxPromptChars)
    : String(promptOrMessages || '').slice(0, config.ollama.maxPromptChars);

  // qwen3 "thinking" mode is very slow; /no_think disables it (much faster, still good quality).
  const isQwen3 = /qwen3/i.test(config.ollama.chatModel);
  const sysContent = isQwen3 ? `${system}\n/no_think` : system;

  const data = await ollamaFetch('/api/chat', {
    model: config.ollama.chatModel,
    messages: [
      { role: 'system', content: sysContent },
      { role: 'user', content: user },
    ],
    stream: false,
    options: {
      temperature: config.ollama.temperature,
      num_predict: config.ollama.maxTokens,
    },
  }, 300000, signal);

  let answer = data.message?.content?.trim();
  // Strip reasoning blocks emitted by "thinking" models (e.g. qwen3): <think>...</think>.
  if (answer) answer = answer.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^<\/?think>/gi, '').trim();
  if (!answer) {
    throw new Error('Ollama returned empty chat response');
  }
  if (answer !== INSUFFICIENT_DATA_MESSAGE && answer.endsWith(INSUFFICIENT_DATA_MESSAGE)) {
    answer = answer.slice(0, -INSUFFICIENT_DATA_MESSAGE.length).trim();
  }
  answer = normalizePlainBusinessAnswer(answer);
  return sanitizeEnterpriseAnswer(answer, user);
}
