import { config } from '../config.js';
import {
  INSUFFICIENT_DATA_MESSAGE,
  sanitizeEnterpriseAnswer,
} from '../utils/answerSanitizer.js';

async function ollamaFetch(path, body, timeoutMs = 300000) {
  const url = `${config.ollama.baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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

function normalizePlainBusinessAnswer(answer) {
  const headingPattern =
    /^(verdict|key findings|recommendation|recommendations|next steps|summary|overall conclusion|business understanding|key insights|query intent|recent activity|enterprise project intelligence report):?$/i;
  const lines = answer
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\*\*(.+?)\*\*:?\s*$/, '$1:').trim())
    .filter((line) => !headingPattern.test(line.replace(/:$/, '')))
    .map((line) => line.replace(/^[-*•]\s+/, '').trim())
    .map((line) => line.replace(/^\d+\.\s+/, '').trim())
    .map((line) => line.replace(/^Task\s*\d+\s*[:.)-]?\s*/i, '').trim())
    .filter(Boolean);

  let text = lines.join(' ');
  text = text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\*\*/g, '')
    .replace(/^Summary of [^:]+:\s*/i, '')
    .replace(/\bConclusion:\s*/gi, 'Overall, ')
    .replace(/Based on the provided context and evidence,\s*/gi, '')
    .replace(/Based on the provided Qdrant context and SharePoint structured data,\s*/gi, '')
    .replace(/Based on the provided context,\s*/gi, '')
    .replace(/The key findings include:\s*/gi, '')
    .replace(/Overall,\s*:\s*/gi, 'Overall, ')
    .replace(/\s+\d+\.\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/The tasks related to ([^.]+?) include:/i, 'The work around $1 includes')
    .replace(/The overall conclusion is that\s+/i, 'Overall, ')
    .trim();

  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (sentences?.length > 4) {
    text = sentences.slice(0, 4).join(' ').trim();
  }

  return text || answer;
}

export async function embedText(text) {
  const truncated = text.slice(0, 8000);

  try {
    const data = await ollamaFetch(
      '/api/embed',
      { model: config.ollama.embedModel, input: truncated },
      120000
    );
    const embedding = data.embeddings?.[0];
    if (embedding?.length) return embedding;
  } catch (err) {
    if (!String(err.message).includes('404')) throw err;
  }

  const legacy = await ollamaFetch(
    '/api/embeddings',
    { model: config.ollama.embedModel, prompt: truncated },
    120000
  );
  const embedding = legacy.embedding;
  if (!embedding?.length) {
    throw new Error('Ollama returned empty embedding');
  }
  return embedding;
}

export async function generateAnswer(promptOrMessages) {
  const isObject = promptOrMessages && typeof promptOrMessages === 'object';
  const system = isObject
    ? String(promptOrMessages.system || '').slice(0, 4000)
    : 'You are an enterprise project intelligence assistant. Use only the context in the user message. Be concise and factual. Never invent data.';
  const user = isObject
    ? String(promptOrMessages.user || '').slice(0, config.ollama.maxPromptChars)
    : String(promptOrMessages || '').slice(0, config.ollama.maxPromptChars);

  const data = await ollamaFetch('/api/chat', {
    model: config.ollama.chatModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    options: {
      temperature: config.ollama.temperature,
      num_predict: config.ollama.maxTokens,
    },
  });

  let answer = data.message?.content?.trim();
  if (!answer) {
    throw new Error('Ollama returned empty chat response');
  }
  if (answer !== INSUFFICIENT_DATA_MESSAGE && answer.endsWith(INSUFFICIENT_DATA_MESSAGE)) {
    answer = answer.slice(0, -INSUFFICIENT_DATA_MESSAGE.length).trim();
  }
  answer = normalizePlainBusinessAnswer(answer);
  return sanitizeEnterpriseAnswer(answer, user);
}
