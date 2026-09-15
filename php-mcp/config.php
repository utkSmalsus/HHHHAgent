<?php
declare(strict_types=1);

// config.local.php (gitignored, never committed) carries the real secrets for wherever this is
// actually deployed — the safe pattern for shared hosting that may not expose real environment
// variables to PHP at all. Falls back to reading real env vars (e.g. the local .env, for running
// this next to the Node app) only if no local override file is present.
$localConfigPath = __DIR__ . '/config.local.php';
if (is_file($localConfigPath)) {
    return require $localConfigPath;
}

require_once __DIR__ . '/lib/Env.php';
load_env(__DIR__ . '/../.env');

return [
    // Shared-secret bearer token every request must present (see index.php's checkAuth()) — null
    // means auth is OFF (fails closed to "reject everything" instead, not "allow everything"; see
    // checkAuth()'s own comment for why a misconfigured deploy must never silently stay open).
    'authToken' => getenv('MCP_AUTH_TOKEN') ?: null,
    'sharepoint' => [
        'tenantId' => getenv('TENANT_ID') ?: null,
        'clientId' => getenv('CLIENT_ID') ?: null,
        'clientSecret' => getenv('CLIENT_SECRET') ?: null,
        'siteId' => getenv('SHAREPOINT_SITE_ID') ?: null,
        'meetingsListId' => getenv('SP_MEETINGS') ?: null,
        'tasksListId' => getenv('SP_TASKS') ?: null,
    ],
    'qdrant' => [
        'url' => rtrim(getenv('QDRANT_URL') ?: 'http://localhost:6333', '/'),
        'apiKey' => getenv('QDRANT_API_KEY') ?: null,
        'collection' => getenv('QDRANT_COLLECTION') ?: 'enterprise_knowledge',
    ],
];
