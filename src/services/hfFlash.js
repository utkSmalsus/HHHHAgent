import { config } from '../config.js';
import { runToolLoop, buildSearchMessages, buildTranscriptRequest } from './qdrantToolLoop.js';

/**
 * Same "model searches Qdrant itself" pattern as hermes.js, but talking directly to a
 * non-reasoning model via Hugging Face's Inference Providers router — no "thinking" token
 * overhead, no CLI process, so it's noticeably faster than the Nous-backed Hermes path.
 */
export async function searchAndAnswer(question, history = []) {
  return runToolLoop({
    baseUrl: config.hfFlash.baseUrl,
    apiKey: config.hfFlash.apiKey,
    model: config.hfFlash.chatModel,
    messages: buildSearchMessages(question, history),
    providerLabel: 'HF Flash',
  });
}

export async function analyzeTranscript(transcriptText, filename = 'transcript', question = '') {
  const { messages, tools, executors } = buildTranscriptRequest(transcriptText, filename, question);
  return runToolLoop({
    baseUrl: config.hfFlash.baseUrl,
    apiKey: config.hfFlash.apiKey,
    model: config.hfFlash.chatModel,
    messages,
    extraTools: tools,
    extraExecutors: executors,
    maxTurns: 6,
    providerLabel: 'HF Flash',
  });
}
