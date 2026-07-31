import { config } from '../config.js';

export async function embedText(text, options = {}) {
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
  if (config.chat.provider === 'ollama') {
    const { generateAnswer: ollamaChat } = await import('./ollama.js');
    return ollamaChat(prompt, options);
  }

  if (config.chat.provider === 'huggingface') {
    const { generateAnswer: hfChat } = await import('./huggingfaceChat.js');
    return hfChat(prompt);
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
