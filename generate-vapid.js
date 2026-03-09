/**
 * Run once: node generate-vapid.js
 * Copy the output into your .env file
 */
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('\n=== VAPID Keys Generated ===\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\nCopy these into your .env file\n');
