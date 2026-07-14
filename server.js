const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const TWEET_TEMPLATES = require('./tweetTemplates');

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const TWEET_MAX_LENGTH = 280;

// Safety valve, not a throughput knob: caps how many *waiting* jobs can
// pile up before we start dropping. With no ffmpeg step, a job is just a
// Telegram upload, so this should rarely fill up in practice.
const MAX_QUEUE_SIZE = 20;

// How many uploads run at once. Telegram enforces a soft per-chat rate
// limit (~1 msg/sec sustained); pushing this much higher just trades
// queue waiting for 429 retries. 3 absorbs bursts without hammering it.
const UPLOAD_CONCURRENCY = config.UPLOAD_CONCURRENCY;

const MAX_UPLOAD_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;

const app = express();
app.use(express.json());

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: false });

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// Base58 check: Solana addresses/signatures never contain 0, O, I, l or symbols.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function shortenWallet(address) {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// Trims noisy on-chain precision (e.g. 0.244444441) down to something readable.
function formatSol(amount) {
  const rounded = Math.round(amount * 1000) / 1000;
  return rounded.toString();
}

function buildTweetText({ amount, wallet, signature }) {
  const ticker = config.TOKEN_TICKER || 'this token';
  const template = TWEET_TEMPLATES[Math.floor(Math.random() * TWEET_TEMPLATES.length)];
  const hook = template.replace(/{amount}/g, amount).replace(/{ticker}/g, ticker);
  const suffix = `\nBuyer: ${shortenWallet(wallet)}\nhttps://solscan.io/tx/${signature}`;

  let text = `${hook}${suffix}`;
  if (text.length > TWEET_MAX_LENGTH) {
    const maxHookLength = TWEET_MAX_LENGTH - suffix.length - 1;
    const trimmedHook = hook.slice(0, Math.max(0, maxHookLength)) + '…';
    text = `${trimmedHook}${suffix}`;
  }
  return text;
}

// Directory listing is read once and cached. It used to run via
// fs.readdirSync on every single job (blocking the event loop each time
// for no reason, since the template set doesn't change at runtime).
let cachedTemplates = null;
function getTemplates() {
  if (!cachedTemplates) {
    cachedTemplates = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.toLowerCase().endsWith('.mp4'));
    if (cachedTemplates.length === 0) {
      throw new Error(`No .mp4 templates found in ${TEMPLATES_DIR}`);
    }
    log(`Cached ${cachedTemplates.length} template(s) from ${TEMPLATES_DIR}`);
  }
  return cachedTemplates;
}

function pickRandomTemplate() {
  const files = getTemplates();
  const choice = files[Math.floor(Math.random() * files.length)];
  return path.join(TEMPLATES_DIR, choice);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Telegram's 429 responses carry a `retry_after` (seconds) hint telling
// you exactly how long to wait - respect that instead of guessing.
function getRetryAfterMs(err) {
  const retryAfter = err && err.response && err.response.body && err.response.body.parameters
    ? err.response.body.parameters.retry_after
    : undefined;
  return typeof retryAfter === 'number' ? retryAfter * 1000 : null;
}

// Once a template has been uploaded to Telegram once, its file_id lets
// every future send of that same template skip re-uploading the bytes
// entirely - Telegram just re-attaches the already-stored file. Since we
// only have a couple of static templates, this turns almost every upload
// after the first into a near-instant metadata call instead of an 8-11MB
// transfer, which is the single biggest throughput win available here.
const templateFileIds = new Map(); // templatePath -> Telegram file_id

async function sendVideoWithRetry(templatePath, chatId, options, signature) {
  let fellBackToRaw = false;

  for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    // Re-read the cache on every attempt, not just once before the loop.
    // A concurrent sibling job can populate a template's file_id while
    // this job is sitting in a backoff sleep - checking fresh each time
    // means a retry can still land as a fast cached upload instead of
    // repeating the slow raw path it started with.
    const cachedFileId = fellBackToRaw ? null : templateFileIds.get(templatePath);
    const source = cachedFileId || templatePath;

    try {
      const result = await bot.sendVideo(chatId, source, options);
      const fileId = result && result.video && result.video.file_id;
      if (fileId && !templateFileIds.has(templatePath)) {
        templateFileIds.set(templatePath, fileId);
      }
      return result;
    } catch (err) {
      // A cached file_id can in rare cases go stale (e.g. Telegram-side
      // cleanup). Fall back to a real re-upload once rather than
      // burning retries on a dead id.
      if (source !== templatePath && !fellBackToRaw) {
        log(`[${signature}] Cached file_id failed, falling back to raw upload -`, err.message);
        templateFileIds.delete(templatePath);
        fellBackToRaw = true;
        continue;
      }

      if (attempt === MAX_UPLOAD_RETRIES) throw err;

      const retryAfterMs = getRetryAfterMs(err);
      const backoffMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
      const delay = retryAfterMs != null ? retryAfterMs : backoffMs;
      log(`[${signature}] Upload attempt ${attempt + 1} failed (${err.message}), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

// ---- Bounded worker-pool queue ----
// Replaces the old single-worker "processing" mutex. Up to
// UPLOAD_CONCURRENCY jobs now run at once; each finished slot immediately
// pulls the next queued job rather than waiting for every earlier job to
// finish. Ordering is intentionally NOT preserved across workers - these
// are independent Telegram messages with no dependency on relative
// on-chain order, so letting them complete out of order is safe and
// lets a fast job (cached file_id) overtake a slow one (first upload of
// a template) instead of queueing behind it.
const queue = [];
const inFlightSignatures = new Set(); // dedupe: skip a signature already queued or being sent
let activeWorkers = 0;

function enqueueBurn(job) {
  if (inFlightSignatures.has(job.signature)) {
    log(`Duplicate trigger for tx ${job.signature} - already queued/in-flight, skipping`);
    return;
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    log(`Queue full (${MAX_QUEUE_SIZE}), dropping trigger for tx`, job.signature);
    return;
  }

  inFlightSignatures.add(job.signature);
  queue.push(job);
  pumpWorkers();
}

function pumpWorkers() {
  while (activeWorkers < UPLOAD_CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    activeWorkers++;
    processBurn(job).finally(() => {
      activeWorkers--;
      inFlightSignatures.delete(job.signature); // bounded: removed as soon as the job settles, never grows unbounded
      pumpWorkers();
    });
  }
}

async function processBurn({ wallet, amount, signature, receivedAt }) {
  const jobStartedAt = Date.now();
  log(`[${signature}] Job started (queue wait ${jobStartedAt - receivedAt}ms)`);

  try {
    const templatePath = pickRandomTemplate();
    const templateSelectedAt = Date.now();
    log(`[${signature}] Template selected: ${path.basename(templatePath)} (+${templateSelectedAt - jobStartedAt}ms)`);

    const solscanUrl = `https://solscan.io/tx/${signature}`;
    const shortWallet = shortenWallet(wallet);
    const displayAmount = formatSol(amount);

    const caption =
      `🔥 *BUY ALERT* 🔥\n` +
      `Amount: *${displayAmount} SOL*\n` +
      `Buyer: \`${shortWallet}\``;

    const tweetText = buildTweetText({ amount: displayAmount, wallet, signature });
    const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

    const uploadStartedAt = Date.now();
    log(`[${signature}] Telegram upload started`);

    await sendVideoWithRetry(templatePath, config.TELEGRAM_CHAT_ID, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🐦 Tweet This Buy', url: tweetUrl },
          { text: '🔍 View on Solscan', url: solscanUrl },
        ]],
      },
    }, signature);

    const uploadCompletedAt = Date.now();
    log(`[${signature}] Telegram upload completed (+${uploadCompletedAt - uploadStartedAt}ms)`);

    const jobFinishedAt = Date.now();
    log(
      `[${signature}] Job finished - processing ${jobFinishedAt - jobStartedAt}ms, ` +
      `total since trigger ${jobFinishedAt - receivedAt}ms`
    );
  } catch (err) {
    const jobFinishedAt = Date.now();
    log(
      `[${signature}] Failed to send burn video - ${err.message} ` +
      `(processing ${jobFinishedAt - jobStartedAt}ms, total since trigger ${jobFinishedAt - receivedAt}ms)`
    );
  }
}

app.post('/trigger-burn', (req, res) => {
  const { wallet, solAmount, signature } = req.body || {};

  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return res.status(400).json({ error: 'Invalid or missing wallet' });
  }
  if (typeof signature !== 'string' || !BASE58_RE.test(signature)) {
    return res.status(400).json({ error: 'Invalid or missing signature' });
  }
  const amount = Number(solAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid or missing solAmount' });
  }

  const receivedAt = Date.now();
  log(`[${signature}] Trigger received: ${amount} SOL from ${wallet} - queue depth ${queue.length}, active workers ${activeWorkers}`);

  res.status(202).json({ status: 'queued' });
  enqueueBurn({ wallet, amount, signature, receivedAt });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(config.PORT, () => {
  log(`Server listening on port ${config.PORT}`);
  log(`Telegram target chat: ${config.TELEGRAM_CHAT_ID}`);
  log(`Upload concurrency: ${UPLOAD_CONCURRENCY}`);
  log(`Threshold (for reference only, enforced by listener.js): ${config.BUY_THRESHOLD_SOL} SOL`);
  getTemplates(); // warm the cache and fail fast at boot if templates/ is empty
});
