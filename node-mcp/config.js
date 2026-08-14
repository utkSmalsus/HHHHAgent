// Standalone config for node-mcp — reads the SAME .env keys as php-mcp/config.php, independently.
// Deliberately does NOT import ../src/config.js or anything under ../src/services — this whole
// folder must have zero dependency on the main Node app, mirroring php-mcp/'s own self-containment.
import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(__dirname, '../.env') });

export const config = {
  sharepoint: {
    tenantId: process.env.TENANT_ID || null,
    clientId: process.env.CLIENT_ID || null,
    clientSecret: process.env.CLIENT_SECRET || null,
    siteId: process.env.SHAREPOINT_SITE_ID || null,
    meetingsListId: process.env.SP_MEETINGS || null,
  },
  qdrant: {
    url: (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, ''),
    apiKey: process.env.QDRANT_API_KEY || null,
    collection: process.env.QDRANT_COLLECTION || 'enterprise_knowledge',
  },
};
