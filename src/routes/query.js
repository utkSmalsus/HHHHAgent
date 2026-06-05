import { Router } from 'express';
import { generateAnswer } from '../services/ai.js';
import { buildContextPack, formatDeterministicAnswer } from '../services/contextPack.js';
import { hybridRetrieve } from '../services/hybridSearch.js';
import { queryStructuredData } from '../services/sharepoint.js';
import {
  buildEnterpriseMessages,
  INSUFFICIENT_DATA_MESSAGE,
} from '../prompts/enterpriseQuery.js';
import {
  evidenceMatchesQuestion,
  filterResultsByQuestion,
} from '../utils/evidenceMatch.js';
import { sanitizeEnterpriseAnswer } from '../utils/answerSanitizer.js';
import { buildEvidenceSummaryAnswer } from '../utils/evidenceSummary.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { question, limit = 8 } = req.body;

    if (!question) {
      return res.status(400).json({ success: false, error: 'question is required' });
    }

    const retrieval = await hybridRetrieve(question, {
      limit: Math.max(Number(limit) || 8, 10),
    });

    const { intent, results, confidence, meta } = retrieval;

    if (!results.length || !evidenceMatchesQuestion(question, results)) {
      return res.json({
        success: true,
        answer: INSUFFICIENT_DATA_MESSAGE,
        confidence: 0,
        intent: intent.intent,
        sources: { qdrant: [], sharepoint: {} },
      });
    }

    const relevantResults = filterResultsByQuestion(question, results);
    const resultsForLlm = relevantResults.length ? relevantResults : results;
    const contextPack = buildContextPack(intent, resultsForLlm);
    const deterministic = formatDeterministicAnswer(intent, contextPack, confidence);

    if (deterministic) {
      const sharepointResult = await queryStructuredData(question, results);
      return res.json({
        success: true,
        answer: deterministic.answer,
        confidence: deterministic.confidence ?? confidence,
        intent: intent.intent,
        counts: deterministic.counts,
        people: deterministic.people,
        contextPack,
        retrievalMeta: meta,
        sources: {
          qdrant: results,
          sharepoint: sharepointResult.data || {},
        },
      });
    }

    const sharepointResult = await queryStructuredData(question, resultsForLlm);
    const sharepointData = sharepointResult.data || {};

    const evidenceFirstIntents = new Set(['summary', 'status', 'risk']);
    let answer = buildEvidenceSummaryAnswer(question, resultsForLlm, contextPack);

    if (!answer && evidenceFirstIntents.has(intent.intent)) {
      answer = INSUFFICIENT_DATA_MESSAGE;
    } else if (!answer) {
      const messages = buildEnterpriseMessages({
        userQuestion: question,
        qdrantContext: resultsForLlm.slice(0, 12),
        contextPack,
      });
      answer = sanitizeEnterpriseAnswer(await generateAnswer(messages), question);
    }

    if (!answer) {
      answer = INSUFFICIENT_DATA_MESSAGE;
    }

    res.json({
      success: true,
      answer,
      confidence,
      intent: intent.intent,
      contextPack,
      retrievalMeta: meta,
      sources: {
        qdrant: resultsForLlm,
        sharepoint: sharepointData,
      },
    });
  } catch (err) {
    console.error('Query error:', err.message);
    const msg = String(err.message || err);
    const status =
      msg.includes('429') || msg.includes('quota')
        ? 429
        : msg.includes('inference provider')
          ? 503
          : 500;
    res.status(status).json({
      success: false,
      error: msg,
      hint:
        status === 429
          ? 'Gemini quota exceeded. Wait ~1 min or use Ollama locally.'
          : undefined,
    });
  }
});

export default router;
