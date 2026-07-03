const fs = require('fs');
const path = require('path');
const express = require('express');
const { execFile } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const TWEET_TEMPLATES = require('./tweetTemplates');

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const OUTPUT_DIR = path.join(__dirname, 'output');
const TWEET_MAX_LENGTH = 280;
// Buys can arrive faster than one ffmpeg encode + Telegram upload can
// finish. Without a cap, every trigger spawns its own ffmpeg process in
// parallel, which is what pins CPU/RAM and makes the machine hang. Jobs
// are processed strictly one at a time; anything beyond this backlog is
// dropped (logged) rather than queued forever.
const MAX_QUEUE_SIZE = 20;

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

// Defense in depth: ffmpeg's drawtext filter treats \ : ' % as special.
// Wallet/amount text should never contain these (base58 has no such chars),
// but strip them just in case so a malformed upstream event can't break
// or hijack the filter graph.
function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '')
    .replace(/:/g, '')
    .replace(/'/g, '')
    .replace(/%/g, '');
}

function pickRandomTemplate() {
  const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.toLowerCase().endsWith('.mp4'));
  if (files.length === 0) {
    throw new Error(`No .mp4 templates found in ${TEMPLATES_DIR}`);
  }
  const choice = files[Math.floor(Math.random() * files.length)];
  return path.join(TEMPLATES_DIR, choice);
}

function findFontPath() {
  const candidates = [
    config.FONT_PATH,
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    'C:\\Windows\\Fonts\\arialbd.ttf',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function buildDrawtextFilter(lines, fontPath) {
  const fontOpt = fontPath ? `fontfile='${fontPath.replace(/'/g, "'\\''")}':` : '';
  return lines
    .map(
      ({ text, y }) =>
        `drawtext=${fontOpt}text='${text}':fontcolor=white:fontsize=42:` +
        `borderw=3:bordercolor=black:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.4:boxborderw=10`
    )
    .join(',');
}

async function renderBurnVideo({ wallet, solAmount }) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const inputPath = pickRandomTemplate();
  const outputPath = path.join(OUTPUT_DIR, `burn_${Date.now()}.mp4`);
  const fontPath = findFontPath();

  const shortWallet = escapeDrawtext(shortenWallet(wallet));
  const amountText = escapeDrawtext(`${formatSol(solAmount)} SOL BUY`);

  const filter = buildDrawtextFilter(
    [
      { text: amountText, y: 'h-160' },
      { text: shortWallet, y: 'h-100' },
    ],
    fontPath
  );

  const args = [
    '-y',
    '-i', inputPath,
    '-vf', filter,
    '-codec:a', 'copy',
    outputPath,
  ];

  log(`Rendering video from ${path.basename(inputPath)} -> ${path.basename(outputPath)}`);

  await new Promise((resolve, reject) => {
    execFile('ffmpeg', args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`ffmpeg failed: ${error.message}\n${stderr}`));
        return;
      }
      resolve();
    });
  });

  log('Video processing finished:', outputPath);
  return outputPath;
}

const queue = [];
let processing = false;

function enqueueBurn(job) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    log(`Queue full (${MAX_QUEUE_SIZE}), dropping trigger for tx`, job.signature);
    return;
  }
  queue.push(job);
  processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const job = queue.shift();
    await processBurn(job);
  }

  processing = false;
}

async function processBurn({ wallet, amount, signature }) {
  let videoPath;
  try {
    videoPath = await renderBurnVideo({ wallet, solAmount: amount });

    const solscanUrl = `https://solscan.io/tx/${signature}`;
    const shortWallet = shortenWallet(wallet);
    const displayAmount = formatSol(amount);

    const caption =
      `🔥 *BUY ALERT* 🔥\n` +
      `Amount: *${displayAmount} SOL*\n` +
      `Buyer: \`${shortWallet}\``;

    const tweetText = buildTweetText({ amount: displayAmount, wallet, signature });
    const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

    await bot.sendVideo(config.TELEGRAM_CHAT_ID, videoPath, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🐦 Tweet This Buy', url: tweetUrl },
          { text: '🔍 View on Solscan', url: solscanUrl },
        ]],
      },
    });

    log('Telegram send succeeded for tx', signature);
  } catch (err) {
    log('Failed to process/send burn video for tx', signature, '-', err.message);
  } finally {
    if (videoPath) {
      fs.unlink(videoPath, (err) => {
        if (err) log('Failed to clean up', videoPath, '-', err.message);
      });
    }
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

  log(`Received trigger: ${amount} SOL from ${wallet} (tx ${signature}) - queue depth ${queue.length}`);

  res.status(202).json({ status: 'queued' });
  enqueueBurn({ wallet, amount, signature });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(config.PORT, () => {
  log(`Server listening on port ${config.PORT}`);
  log(`Telegram target chat: ${config.TELEGRAM_CHAT_ID}`);
  log(`Threshold (for reference only, enforced by listener.js): ${config.BUY_THRESHOLD_SOL} SOL`);
});
