import cors from 'cors';
import { config } from '../config.js';

/**
 * CORS for SPFx / SharePoint workbench.
 * Origin must match exactly (scheme + host + port) — no trailing slash.
 */
export const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (config.cors.origins.includes(origin)) {
      return callback(null, true);
    }
    if (config.cors.allowLocalDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    console.warn(`CORS blocked origin: ${origin}`);
    callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  optionsSuccessStatus: 204,
});

export function corsPreflight(app) {
  app.options('*', corsMiddleware);
}
