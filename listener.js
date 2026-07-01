const WebSocket = require('ws');
const fetch = require('node-fetch');
const config = require('./config');

const PUMPPORTAL_BASE_URL = 'wss://pumpportal.fun/api/data';
const RECONNECT_DELAY_MS = 3000;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function connect() {
  const url = config.PUMPPORTAL_API_KEY
    ? `${PUMPPORTAL_BASE_URL}?api-key=${encodeURIComponent(config.PUMPPORTAL_API_KEY)}`
    : PUMPPORTAL_BASE_URL;
  const ws = new WebSocket(url);

  ws.on('open', () => {
    log('Connected to pumpportal.fun. Subscribing to trades for', config.TOKEN_MINT_ADDRESS);
    ws.send(JSON.stringify({
      method: 'subscribeTokenTrade',
      keys: [config.TOKEN_MINT_ADDRESS],
    }));
  });

  ws.on('message', async (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch (err) {
      log('Failed to parse message, skipping:', err.message);
      return;
    }

    if (config.DEBUG) log('Raw event:', JSON.stringify(event));

    if (typeof event.message === 'string' && event.txType === undefined) {
      log('pump.fun server message:', event.message);
      return;
    }

    if (event.txType !== 'buy') return;
    if (typeof event.solAmount !== 'number') return;
    if (event.solAmount < config.BUY_THRESHOLD_SOL) return;

    log(
      `Qualifying buy detected: ${event.solAmount} SOL by ${event.traderPublicKey} ` +
      `(tx ${event.signature})`
    );

    try {
      const res = await fetch(config.BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: event.traderPublicKey,
          solAmount: event.solAmount,
          signature: event.signature,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        log(`Backend responded with ${res.status}:`, text);
      } else {
        log('Backend accepted the trigger for tx', event.signature);
      }
    } catch (err) {
      log('Failed to POST to backend:', err.message);
    }
  });

  ws.on('close', () => {
    log(`WebSocket closed. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on('error', (err) => {
    log('WebSocket error:', err.message);
    ws.close();
  });
}

if (!config.PUMPPORTAL_API_KEY) {
  log(
    'WARNING: no PUMPPORTAL_API_KEY set. pump.fun rejects subscribeTokenTrade ' +
    'without a funded (>= 0.02 SOL) API key - you will not receive any trade events.'
  );
}

log(`Starting listener. Threshold: ${config.BUY_THRESHOLD_SOL} SOL. Backend: ${config.BACKEND_URL}`);
connect();
