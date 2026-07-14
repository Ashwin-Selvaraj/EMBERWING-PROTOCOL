# EMBERWING-PROTOCOL
This report outlines the technical and community-growth infrastructure powering $EMBR (Emberwing) — a Solana meme token built around real-time, on-chain-triggered engagement mechanics rather than passive buy-bot spam. It covers three integrated systems: (1) the Dracarys Burn Bot

## Dracarys Burn Bot — setup & operation

Watches pump.fun trades for `$EMBR` and posts an auto-generated video alert to a
Telegram group whenever a buy exceeds a configurable SOL threshold.

The system has two processes:

- **`listener.js`** — connects to pump.fun's public trade WebSocket
  (`wss://pumpportal.fun/api/data`), subscribes to trades for the configured
  mint, and filters for buys at or above the threshold. Auto-reconnects every
  3s if the connection drops.
- **`server.js`** — an Express backend with a `POST /trigger-burn` endpoint.
  When called, it picks a random pre-existing clip from `./templates` and
  posts it as-is to your Telegram group with an inline "🐦 Tweet This Buy"
  button. Clicking it opens Twitter/X with the amount, wallet, and Solscan
  link pre-filled in a tweet composer — note that Twitter's share intent
  can't auto-attach the video itself (no platform supports that via a plain
  link), so the person tweeting would need to manually download and attach
  the video if they want it included. Uploads run concurrently (see
  `UPLOAD_CONCURRENCY` below) with retry/backoff on Telegram rate limits, and
  each template's Telegram `file_id` is cached after its first upload so
  repeat sends skip re-transferring the file.

`listener.js` never talks to Telegram directly — it just POSTs qualifying
buys to the backend. This keeps the on-chain watcher simple and lets you
re-send without reconnecting to the socket.

### 1. Install dependencies

```bash
npm install
```

This installs `ws`, `express`, `node-telegram-bot-api`, `dotenv`,
`node-fetch`, and (as a dev dependency) `concurrently` to run both processes
with one command. No other system dependencies are required — the backend
uploads the pre-existing template files directly, it doesn't render or
transcode video.

### 2. Get a pumpportal.fun API key

pump.fun's real-time trade WebSocket gates `subscribeTokenTrade` /
`subscribeAccountTrade` behind a funded API key — without one, the
subscription is silently rejected and you'll never receive trade events
(the listener will run and "connect", but nothing will ever log).

1. Generate a wallet + API key pair (do this yourself in your own terminal —
   the response contains a private key and should never be pasted into a
   chat or shared with anyone):
   ```bash
   curl https://pumpportal.fun/api/create-wallet
   ```
2. The response is JSON with a newly generated Lightning wallet
   (public/private key) and its linked `apiKey`. Save it somewhere safe.
3. Fund the wallet's public key with **at least 0.02 SOL** — pumpportal's
   minimum to unlock `subscribeTokenTrade`/`subscribeAccountTrade`. This is
   separate from the SOL you're monitoring on your own token.
4. **This isn't a one-time cost** — pumpportal charges 0.01 SOL per 10,000
   WebSocket messages received on that wallet, ongoing. Keep a small buffer
   topped up, or the subscription can silently stop working again once the
   balance drains.
5. Put the `apiKey` value in `.env` as `PUMPPORTAL_API_KEY`.

If you skip this, `listener.js` prints a startup warning and you'll see zero
buy logs no matter how much real trading volume is happening.

### 3. Get a Telegram bot token

1. Open a chat with [@BotFather](https://t.me/BotFather) on Telegram.
2. Send `/newbot` and follow the prompts (choose a name and a unique
   username ending in `bot`).
3. BotFather replies with an HTTP API token — this is your
   `TELEGRAM_BOT_TOKEN`. Keep it secret; anyone with it controls your bot.
4. Add the bot to your group and **promote it to admin** (or at minimum give
   it permission to post media) — bots can't post in groups otherwise.

### 4. Find your group's chat ID

Most reliable method — use your own bot, no third-party bot needed
(third-party ID bots like @RawDataBot can be unreliable or get removed):

1. Make sure your bot is already a member of the group (see step 4).
2. Send any command message in the group, e.g. `/id` (messages starting
   with `/` always reach a bot regardless of privacy-mode settings).
3. Fetch pending updates:
   ```bash
   curl -s "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
   ```
4. In the JSON response, find `"chat": { "id": -100xxxxxxxxxx, ... }`.
   That `id` (including the `-` sign) is your `TELEGRAM_CHAT_ID`. Group IDs
   are negative; supergroups usually start with `-100`.
5. If you get `{"result":[]}`, check the URL in a fresh terminal/curl call
   rather than a browser — browsers can cache the GET response and show you
   a stale empty result even after the message went through.

### 5. Configure `.env`

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

```ini
TOKEN_MINT_ADDRESS=YOUR_MINT_ADDRESS_HERE
PUMPPORTAL_API_KEY=YOUR_PUMPPORTAL_API_KEY_HERE
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN_HERE
TELEGRAM_CHAT_ID=YOUR_GROUP_CHAT_ID_HERE
TOKEN_TICKER=$EMBR
BUY_THRESHOLD_SOL=5
PORT=3000
BACKEND_URL=http://localhost:3000/trigger-burn
UPLOAD_CONCURRENCY=3
```

Everything the bot needs to know — mint address, threshold, tokens — lives
here. **Never edit the threshold or mint in the `.js` files**; both are read
from `.env` via `config.js` at startup, so changing behavior is just an
edit-and-restart.

`.env` is gitignored — don't commit it, it contains your bot token and API key.

### 6. Add video templates

Drop 3–5 short `.mp4` clips into `./templates/`, e.g.:

```
templates/burn1.mp4
templates/burn2.mp4
templates/burn3.mp4
```

One is chosen at random for each alert and uploaded as-is (no processing).
Keep them short/small so the *first* upload of each template is fast — after
that, its Telegram `file_id` is cached and every later send of that same
template is a near-instant re-attach rather than a fresh upload.

### 7. Run it

```bash
npm start
```

This uses `concurrently` to run `node server.js` and `node listener.js` in
one terminal with color-coded, labeled output (`SERVER` / `LISTENER`). You
can also run them in two separate terminals during development:

```bash
npm run server     # terminal 1
npm run listener   # terminal 2
```

### Logging

Both processes log timestamped lines to the terminal for:

- a qualifying buy detected by the listener (amount, wallet, tx signature)
- the backend receiving the trigger, tagged `[signature]`, with the current
  queue depth and active worker count
- per-job stage timings: queue wait, template selection, upload start/finish,
  and total processing time — all tagged with the same `[signature]` so you
  can grep one transaction's full timeline out of interleaved concurrent logs
- the Telegram send succeeding or failing (with the error message), including
  retry attempts with their backoff delay on rate-limit (429) responses

---

## Testing safely before going live

**Do not point this at your real token/threshold/group on the first run.**
Verify the full pipeline end-to-end with low stakes first:

1. **Use a throwaway or low-cap test token**, not `$EMBR`. Any mint actively
   trading on pump.fun works — you just need real trade events to flow.
2. **Create a private Telegram test group** (just you, or you + a friend)
   and a *second* bot via BotFather for testing, so you never risk posting
   test spam to your real community group.
3. **Set a tiny threshold** in `.env` so a normal small buy triggers it:
   ```ini
   TOKEN_MINT_ADDRESS=<test_token_mint>
   PUMPPORTAL_API_KEY=<your pumpportal API key>
   TELEGRAM_BOT_TOKEN=<test_bot_token>
   TELEGRAM_CHAT_ID=<test_group_chat_id>
   BUY_THRESHOLD_SOL=0.05
   ```
4. Run `npm start` and watch the logs. Buy a tiny amount of the test token
   yourself (or wait for organic trades) and confirm:
   - the listener logs "Qualifying buy detected"
   - the server logs "Trigger received", then "Job started", "Template
     selected", "Telegram upload started", and "Telegram upload completed"
   - the video + caption show up in your test group with the right amount,
     wallet, and a working Solscan link
5. Try a buy *below* your threshold too, and confirm nothing fires — this
   catches off-by-one or unit mistakes (lamports vs. SOL) before they matter.
6. Only after that full round-trip works, edit `.env`:
   ```ini
   TOKEN_MINT_ADDRESS=<your real $EMBR mint>
   PUMPPORTAL_API_KEY=<your pumpportal API key>
   TELEGRAM_BOT_TOKEN=<your real bot token>
   TELEGRAM_CHAT_ID=<your real group chat id>
   BUY_THRESHOLD_SOL=5
   ```
   and restart (`npm start`). No code changes needed — it's purely a `.env`
   swap, which is the whole point of keeping these values out of the source.

### Notes / gotchas

- If the listener connects but never logs a buy, check for a rejection
  message first — set `DEBUG=true` in `.env` and restart; every raw event
  (including server error messages like a missing/underfunded API key) gets
  logged. This is the #1 cause of "trades are happening but I see nothing."
- pump.fun's WebSocket schema can change; with `DEBUG=true` you'll see the
  exact raw event shape, so you can confirm `txType`/`solAmount`/
  `traderPublicKey`/`signature` still match what `listener.js` expects.
- If uploads are consistently slow, check the logs for repeated "Upload
  attempt N failed ... retrying" lines — that's Telegram's rate limit
  (429), not a bug; the backoff (and `retry_after` hint when Telegram sends
  one) handles it automatically. Lowering `UPLOAD_CONCURRENCY` reduces how
  often you hit it in the first place.
- If you see "Queue full (20), dropping trigger" during a burst, that's the
  backpressure valve working as intended — it means qualifying buys are
  arriving faster than `UPLOAD_CONCURRENCY` workers can drain them. Raise
  `UPLOAD_CONCURRENCY` a little, but keep an eye on the retry logs above
  before pushing it too high.
- Treat your `TELEGRAM_BOT_TOKEN` like a password — rotate it via
  @BotFather (`/revoke`) if it ever leaks.
