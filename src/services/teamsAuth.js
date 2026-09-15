import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

/**
 * Delegated (not application) Graph auth for reading Teams chat messages — sharepoint.js's
 * client-credentials flow (app-only, `.default` scope) can't read chats at all without the
 * `Chat.Read.All` APPLICATION permission, a far more sensitive grant than delegated `Chat.Read`
 * on a real signed-in user. Uses the OAuth2 device-code flow (one-time interactive login, see
 * scripts/teams-auth-setup.js) against the SAME Azure AD app registration sharepoint.js already
 * uses (same CLIENT_ID/TENANT_ID), then keeps itself signed in indefinitely via the returned
 * refresh_token — this file never sees a password, only whatever Microsoft's own login page issues.
 */

const STATE_DIR = process.env.INGEST_STATE_DIR || path.join(process.cwd(), '.state');
const TOKEN_FILE = path.join(STATE_DIR, 'teams-token.json');

// offline_access is required to receive a refresh_token at all (the v2.0 endpoint omits it
// otherwise); Chat.Read is the actual data scope (read the signed-in user's own chats/messages).
export const TEAMS_AUTH_SCOPES = 'offline_access Chat.Read';

function tokenEndpoint() {
  const { tenantId } = config.sharepoint;
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

async function readStoredToken() {
  try {
    return JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeStoredToken(data) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(data, null, 2));
}

/** Step 1 of the device-code flow — call once from the interactive setup script. */
export async function requestDeviceCode() {
  const { clientId } = config.sharepoint;
  const res = await fetch(`https://login.microsoftonline.com/${config.sharepoint.tenantId}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: TEAMS_AUTH_SCOPES }),
  });
  if (!res.ok) {
    throw new Error(`Device code request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Step 2 — poll until the user completes the login shown by requestDeviceCode(). Saves the
 *  refresh token on success so getTeamsAccessToken() can run unattended from then on. */
export async function pollForToken(deviceCode, intervalSeconds, expiresInSeconds) {
  const { clientId, clientSecret } = config.sharepoint;
  const deadline = Date.now() + expiresInSeconds * 1000;
  let interval = intervalSeconds;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch(tokenEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      await writeStoredToken({
        refresh_token: data.refresh_token,
        access_token: data.access_token,
        expires_at: Date.now() + (data.expires_in - 60) * 1000,
      });
      return data;
    }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      interval += 5;
      continue;
    }
    throw new Error(`Device code login failed: ${data.error} — ${data.error_description || ''}`);
  }
  throw new Error('Device code login timed out — the code expired before login completed.');
}

/** Cached access token for ongoing use — refreshes via the stored refresh_token when expired,
 *  same shape/caching pattern as sharepoint.js's getAccessToken(). Returns null (not configured)
 *  rather than throwing, so ingestion can skip Teams EOD reports gracefully until setup runs. */
export async function getTeamsAccessToken() {
  const stored = await readStoredToken();
  if (!stored) return null;
  if (stored.access_token && Date.now() < stored.expires_at) {
    return stored.access_token;
  }

  const { clientId, clientSecret } = config.sharepoint;
  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
      scope: TEAMS_AUTH_SCOPES,
    }),
  });
  if (!res.ok) {
    console.error('Teams token refresh failed:', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  // Microsoft may rotate the refresh_token on use — always persist whichever one comes back,
  // never keep reusing the old one once a new one has been issued.
  await writeStoredToken({
    refresh_token: data.refresh_token || stored.refresh_token,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  });
  return data.access_token;
}

export async function isTeamsAuthConfigured() {
  return Boolean(await readStoredToken());
}
