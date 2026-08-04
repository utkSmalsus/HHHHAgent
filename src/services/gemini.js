import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';

let client;

function getClient() {
  if (!client) {
    if (!config.gemini.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    client = new GoogleGenerativeAI(config.gemini.apiKey);
  }
  return client;
}

function isQuotaError(err) {
  const msg = String(err?.message || err);
  return msg.includes('429') || msg.includes('quota') || msg.includes('Quota exceeded');
}

function parseRetrySeconds(err) {
  const match = String(err?.message || '').match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  return match ? Math.min(120, Math.ceil(Number(match[1])) + 2) : 40;
}

export async function generateAnswer(promptOrMessages) {
  const ai = getClient();
  const model = ai.getGenerativeModel({ model: config.gemini.chatModel });
  const isObject = promptOrMessages && typeof promptOrMessages === 'object';
  const prompt = isObject
    ? `${promptOrMessages.system || ''}\n\n${promptOrMessages.user || ''}`.trim()
    : String(promptOrMessages || '');
  const truncated = prompt.slice(0, config.gemini.maxPromptChars);
  const maxAttempts = config.gemini.maxRetries;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await model.generateContent(truncated);
      const text = result.response.text();
      if (!text?.trim()) {
        throw new Error('Gemini returned empty response');
      }
      return text.trim();
    } catch (err) {
      lastError = err;
      if (!isQuotaError(err) || attempt === maxAttempts) {
        throw formatGeminiError(err);
      }
      const waitSec = parseRetrySeconds(err);
      console.warn(`Gemini quota/rate limit, retry ${attempt}/${maxAttempts} in ${waitSec}s…`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }
  throw formatGeminiError(lastError);
}

function formatGeminiError(err) {
  const msg = String(err?.message || err);
  if (isQuotaError(err)) {
    return new Error(
      'Gemini API quota exceeded (free tier limit). Wait a minute and retry, enable billing at https://ai.google.dev, or set GEMINI_CHAT_MODEL=gemini-2.0-flash-lite in .env. ' +
        msg.slice(0, 200)
    );
  }
  return err;
}
