import { config } from '../config.js';
import { runToolLoop, buildSearchMessages, buildTranscriptRequest } from './qdrantToolLoop.js';

/**
 * Bypasses this app's own intent-detection/retrieval pipeline entirely — the model searches
 * Qdrant itself and answers directly, the same way a human analyst would by running ad-hoc
 * queries, instead of routing through our regex-based resolvers. Talks straight to the Nous
 * model over HTTP (via the already-running `hermes proxy`) rather than spawning the full Hermes
 * CLI agent, so there's no process startup and no unrelated toolsets loaded.
 */
export async function searchAndAnswer(question, history = []) {
  return runToolLoop({
    baseUrl: config.hermes.baseUrl,
    apiKey: 'local',
    model: config.hermes.chatModel,
    messages: buildSearchMessages(question, history),
    providerLabel: 'Hermes proxy',
  });
}

/**
 * Transcript analysis via the same tool-calling loop — the model reads the transcript, decides
 * what to search for based on what it actually names, and cross-references real historical data
 * itself instead of being handed a fixed pre-retrieved context blob.
 */
export async function analyzeTranscript(transcriptText, filename = 'transcript', question = '') {
  const { messages, tools, executors } = buildTranscriptRequest(transcriptText, filename, question);
  return runToolLoop({
    baseUrl: config.hermes.baseUrl,
    apiKey: 'local',
    model: config.hermes.chatModel,
    messages,
    extraTools: tools,
    extraExecutors: executors,
    // Nous Portal sits behind a Cloudflare timeout (~100s) — verified live that the full 10-turn
    // cap + a large transcript slice reliably tipped past it (524 Gateway Timeout) on longer/more
    // complex transcripts. Fewer turns finishes faster at some cost to how much it cross-references.
    maxTurns: 6,
    providerLabel: 'Hermes proxy',
  });
}

export async function generateAnswer(promptOrMessages) {
  const isObject = promptOrMessages && typeof promptOrMessages === 'object';
  const system = isObject ? String(promptOrMessages.system || '') : '';
  const user = isObject ? String(promptOrMessages.user || '') : String(promptOrMessages || '');
  const truncatedUser = user.slice(0, config.hermes.maxPromptChars);

  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: truncatedUser }]
    : [{ role: 'user', content: truncatedUser }];

  let res;
  try {
    res = await fetch(`${config.hermes.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
      body: JSON.stringify({ model: config.hermes.chatModel, messages }),
    });
  } catch (err) {
    throw new Error(
      `Cannot reach Hermes proxy at ${config.hermes.baseUrl}. Run: hermes proxy start --provider nous`
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Hermes proxy ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = JSON.parse(text);
  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) {
    throw new Error('Hermes returned empty response');
  }
  return answer;
}
