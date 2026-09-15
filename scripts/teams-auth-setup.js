#!/usr/bin/env node
// One-time interactive login for Teams EOD-report ingestion (see src/services/teamsAuth.js).
// Run this ONCE, signed in as the account whose Teams chats should be read (Umang Kumar's, per
// the decision made when this was built) — it prints a code and a URL; open the URL, enter the
// code, sign in, and approve. After that, ingestion refreshes its own token automatically and
// this never needs to run again unless the stored refresh token is deleted or revoked.
import { requestDeviceCode, pollForToken } from '../src/services/teamsAuth.js';

const device = await requestDeviceCode();
console.log(device.message);
console.log(`\nWaiting for login… (code expires in ${Math.round(device.expires_in / 60)} minutes)`);

await pollForToken(device.device_code, device.interval, device.expires_in);
console.log('\nSigned in — Teams EOD ingestion can now run unattended.');
