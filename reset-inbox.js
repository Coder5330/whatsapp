#!/usr/bin/env node
// Clear one inbox's password so its owner can set a new one.
//
//   node reset-inbox.js <id>
//
// Use it when someone forgets their password. The inbox goes back to
// unclaimed; a fresh setup code is issued the next time that WhatsApp
// authenticates (restart the service, or have them re-link from the QR
// page, which shows the new code on screen).

const db = require('./db');

async function main() {
  const userId = process.argv[2];

  if (!userId) {
    console.error('Usage: node reset-inbox.js <id>');
    console.error('  <id> is the inbox id from the USERS array in index.js.');
    process.exit(1);
  }
  if (!db.isConfigured) {
    console.error('DATABASE_URL is not set — nothing to reset against.');
    process.exit(1);
  }

  await db.init();
  const before = await db.getCredential(userId);
  if (!before) {
    console.error(`No stored credential for "${userId}". Nothing to do.`);
    console.error('(Ids are case-sensitive and must match the USERS array in index.js.)');
    process.exit(1);
  }

  await db.resetInbox(userId);
  console.log(`Reset "${userId}". It now has no password and no setup code.`);
  console.log('Restart the service (or have them re-link from the QR page) to issue a new code.');
  await db.close();
}

main().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
