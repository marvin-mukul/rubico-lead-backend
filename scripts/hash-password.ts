import { hash } from '@node-rs/argon2';

/**
 * Generates the argon2id hash for DASHBOARD_PASSWORD_HASH (§10).
 *   npm run auth:hash -- 'your-password'
 */
const password = process.argv[2];

if (!password) {
  console.error("Usage: npm run auth:hash -- '<password>'");
  process.exit(1);
}

console.log(await hash(password));
