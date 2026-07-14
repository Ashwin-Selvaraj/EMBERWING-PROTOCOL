require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value || value.includes('YOUR_') ) {
    throw new Error(`Missing/placeholder value for required env var: ${name}. Check your .env file.`);
  }
  return value;
}

module.exports = {
  TOKEN_MINT_ADDRESS: required('TOKEN_MINT_ADDRESS'),
  TELEGRAM_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_CHAT_ID: required('TELEGRAM_CHAT_ID'),
  BUY_THRESHOLD_SOL: parseFloat(process.env.BUY_THRESHOLD_SOL || '5'),
  PORT: parseInt(process.env.PORT || '3000', 10),
  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:3000/trigger-burn',
  DEBUG: process.env.DEBUG === 'true',
  PUMPPORTAL_API_KEY: process.env.PUMPPORTAL_API_KEY || '',
  TOKEN_TICKER: process.env.TOKEN_TICKER || '',
  // How many Telegram uploads run concurrently. Telegram's soft per-chat
  // rate limit is roughly 1 msg/sec sustained, so pushing this much
  // higher mostly just trades queue waiting for 429 retries.
  UPLOAD_CONCURRENCY: parseInt(process.env.UPLOAD_CONCURRENCY || '3', 10),
};
