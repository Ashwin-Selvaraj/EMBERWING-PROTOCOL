const fs = require('fs');
const path = require('path');
const express = require('express');
const { execFile } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const OUTPUT_DIR = path.join(__dirname, 'output');

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
  const amountText = escapeDrawtext(`${solAmount} SOL BUY`);

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

app.post('/trigger-burn', async (req, res) => {
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

  log(`Received trigger: ${amount} SOL from ${wallet} (tx ${signature})`);

  // Respond immediately; do the heavy lifting async so pumpportal events
  // never back up behind ffmpeg/Telegram latency.
  res.status(202).json({ status: 'processing' });

  try {
    const videoPath = await renderBurnVideo({ wallet, solAmount: amount });

    const caption =
      `🔥 *BUY ALERT* 🔥\n` +
      `Amount: *${amount} SOL*\n` +
      `Buyer: \`${shortenWallet(wallet)}\`\n` +
      `[View on Solscan](https://solscan.io/tx/${signature})`;

    await bot.sendVideo(config.TELEGRAM_CHAT_ID, videoPath, {
      caption,
      parse_mode: 'Markdown',
    });

    log('Telegram send succeeded for tx', signature);
  } catch (err) {
    log('Failed to process/send burn video for tx', signature, '-', err.message);
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(config.PORT, () => {
  log(`Server listening on port ${config.PORT}`);
  log(`Telegram target chat: ${config.TELEGRAM_CHAT_ID}`);
  log(`Threshold (for reference only, enforced by listener.js): ${config.BUY_THRESHOLD_SOL} SOL`);
});
