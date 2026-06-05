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

function formatHfChatError(err, model) {
  const msg = String(err?.message || err);
  if (msg.includes('inference provider')) {
    return new Error(
      `Hugging Face chat model "${model}" has no Inference Provider. ` +
        'Enable providers at https://huggingface.co/settings/inference-providers ' +
        `or set HF_CHAT_MODEL=mistralai/Mistral-7B-Instruct-v0.3. Original: ${msg.slice(0, 120)}`
    );
  }
  return err;
}

export async function generateAnswer(prompt) {
  const hf = getClient();
  const { chatModel, maxTokens, temperature } = config.huggingface;

  try {
    const response = await hf.chatCompletion({
      model: chatModel,
      messages: [
        {
          role: 'system',
          content:
            'You are an enterprise project intelligence assistant. Use only provided context. Be concise and factual.',
        },
        { role: 'user', content: prompt.slice(0, 8000) },
      ],
      max_tokens: maxTokens,
      temperature,
      provider: 'hf-inference',
    });

    const content = response.choices?.[0]?.message?.content?.trim();
    if (content) return content;
  } catch (err) {
    throw formatHfChatError(err, chatModel);
  }

  try {
    const legacy = await hf.textGeneration({
      model: chatModel,
      inputs: prompt.slice(0, 8000),
      parameters: { max_new_tokens: maxTokens, temperature, return_full_text: false },
      provider: 'hf-inference',
    });
    return (legacy.generated_text || '').trim();
  } catch (err) {
    throw formatHfChatError(err, chatModel);
  }
}
