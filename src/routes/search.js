import { Router } from 'express';
import { buildContextPack } from '../services/contextPack.js';
import { hybridRetrieve } from '../services/hybridSearch.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { query, limit = 10 } = req.body;

    if (!query) {
      return res.status(400).json({ success: false, error: 'query is required' });
    }

    const retrieval = await hybridRetrieve(query, { limit: Math.min(Number(limit) || 10, 25) });
    const contextPack = buildContextPack(retrieval.intent, retrieval.results);

    res.json({
      success: true,
      query,
      intent: retrieval.intent.intent,
      confidence: retrieval.confidence,
      count: retrieval.results.length,
      contextPack,
      retrievalMeta: retrieval.meta,
      results: retrieval.results,
    });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
