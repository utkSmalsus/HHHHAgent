import { Router } from 'express';
import multer from 'multer';
import { analyzeUploadedTranscript } from '../services/uploadedMeetingAnalysis.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(pdf|docx|txt)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Only .pdf, .docx, and .txt files are supported'), ok);
  },
});

function uploadOne(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ success: false, error: err.message });
  });
}

router.get('/analyze/ui', (_req, res) => res.redirect('/api/query/ui'));

router.post('/analyze', uploadOne, async (req, res) => {
  try {
    const result = await analyzeUploadedTranscript(req.file);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Meeting transcript analysis error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
