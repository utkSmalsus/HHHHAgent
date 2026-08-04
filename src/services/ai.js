import { config } from '../config.js';
import { MAX_CHUNK_CHARS } from '../utils/chunking.js';

// Every embedding provider used to silently do `text.slice(0, 8000)`, so anything longer lost its
// tail with no error, no warning and no trace — the exact class of bug that made long transcripts
// only partially searchable. Ingestion chunks before embedding (chunks top out at MAX_CHUNK_CHARS),
// and queries are short, so nothing legitimate comes close to this ceiling. Headroom of 2x absorbs
// provider-side prefixes (e.g. the "passage: " that huggingface.js prepends) without masking a real
// bug: if oversized text ever reaches here it means a caller bypassed chunkText(), and failing loudly
// is strictly better than silently embedding a fraction of the content and calling it indexed.
const MAX_EMBED_CHARS = MAX_CHUNK_CHARS * 2;

export async function embedText(text, options = {}) {
  const input = String(text ?? '');
  if (input.length > MAX_EMBED_CHARS) {
    throw new Error(
      `embedText received ${input.length} chars, exceeding the ${MAX_EMBED_CHARS}-char limit. ` +
        'Long text must be split with chunkText() before embedding — refusing to silently truncate.'
    );
  }

  switch (config.embeddings.provider) {
    case 'ollama': {
      const { embedText: ollamaEmbed } = await import('./ollama.js');
      return ollamaEmbed(text);
    }
    case 'huggingface': {
      const { embedText: hfEmbed } = await import('./huggingface.js');
      return hfEmbed(text, options);
    }
    default: {
      const { embedText: localEmbed } = await import('./localEmbeddings.js');
      return localEmbed(text);
    }
  }
}

export async function generateAnswer(prompt, options = {}) {
  const provider = options.provider || config.chat.provider;

  if (provider === 'ollama') {
    const { generateAnswer: ollamaChat } = await import('./ollama.js');
    return ollamaChat(prompt, options);
  }

  if (provider === 'huggingface') {
    const { generateAnswer: hfChat } = await import('./huggingfaceChat.js');
    return hfChat(prompt);
  }

  if (provider === 'hermes') {
    const { generateAnswer: hermesChat } = await import('./hermes.js');
    return hermesChat(prompt);
  }

  try {
    const { generateAnswer: geminiChat } = await import('./gemini.js');
    return await geminiChat(prompt);
  } catch (geminiErr) {
    const msg = String(geminiErr.message || geminiErr);
    const quotaHit = msg.includes('429') || msg.includes('quota');

    if (quotaHit && config.chat.fallbackToHf && config.huggingface.apiKey) {
      try {
        console.warn('Gemini quota hit, trying Hugging Face chat fallback…');
        const { generateAnswer: hfChat } = await import('./huggingfaceChat.js');
        return await hfChat(prompt);
      } catch (hfErr) {
        throw new Error(
          `Gemini quota exceeded. HF chat fallback also failed: ${hfErr.message}. ` +
            'Tip: set CHAT_PROVIDER=ollama to use local Ollama instead.'
        );
      }
    }
    throw geminiErr;
  }
}
