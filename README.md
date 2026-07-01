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
  When called, it picks a random clip from `./templates`, overlays the buy
  amount and shortened wallet address with ffmpeg, and posts the result to
  your Telegram group.

`listener.js` never talks to Telegram directly — it just POSTs qualifying
buys to the backend. This keeps the on-chain watcher simple and lets you
re-render/re-send without reconnecting to the socket.

### 1. Install dependencies

```bash
npm install
```

This installs `ws`, `express`, `node-telegram-bot-api`, `dotenv`,
`node-fetch`, and (as a dev dependency) `concurrently` to run both processes
with one command.

### 2. Install ffmpeg

The backend shells out to the `ffmpeg` binary, so it must be on your `PATH`.

- **macOS (Homebrew):** `brew install ffmpeg`
- **Ubuntu/Debian:** `sudo apt install ffmpeg`
- **Windows:** download a build from [ffmpeg.org](https://ffmpeg.org/download.html)
  and add its `bin` folder to your `PATH`.

Verify with:

```bash
ffmpeg -version
```

### 3. Get a Telegram bot token

1. Open a chat with [@BotFather](https://t.me/BotFather) on Telegram.
2. Send `/newbot` and follow the prompts (choose a name and a unique
   username ending in `bot`).
3. BotFather replies with an HTTP API token — this is your
   `TELEGRAM_BOT_TOKEN`. Keep it secret; anyone with it controls your bot.
4. Add the bot to your group and **promote it to admin** (or at minimum give
   it permission to post media) — bots can't post in groups otherwise.

### 4. Find your group's chat ID

Easiest method:

1. Add [@RawDataBot](https://t.me/RawDataBot) (or your own bot) to the group.
2. Send any message in the group.
3. The bot replies with a JSON blob — look for `"chat": { "id": -100xxxxxxxxxx, ... }`.
4. That `id` (including the `-` sign) is your `TELEGRAM_CHAT_ID`. Group IDs
   are negative numbers; supergroups usually start with `-100`.
5. Remove @RawDataBot from the group afterwards if you don't want it there.

### 5. Configure `.env`

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

```ini
TOKEN_MINT_ADDRESS=YOUR_MINT_ADDRESS_HERE
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN_HERE
TELEGRAM_CHAT_ID=YOUR_GROUP_CHAT_ID_HERE
BUY_THRESHOLD_SOL=5
PORT=3000
BACKEND_URL=http://localhost:3000/trigger-burn
FONT_PATH=
```

Everything the bot needs to know — mint address, threshold, tokens — lives
here. **Never edit the threshold or mint in the `.js` files**; both are read
from `.env` via `config.js` at startup, so changing behavior is just an
edit-and-restart.

`.env` is gitignored — don't commit it, it contains your bot token.

### 6. Add video templates

Drop 3–5 short `.mp4` clips into `./templates/`, e.g.:

```
templates/burn1.mp4
templates/burn2.mp4
templates/burn3.mp4
```

One is chosen at random for each alert. Keep them short (a few seconds) so
Telegram uploads stay fast.

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
- the backend receiving the trigger
- ffmpeg finishing video processing
- the Telegram send succeeding or failing (with the error message)

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
   TELEGRAM_BOT_TOKEN=<test_bot_token>
   TELEGRAM_CHAT_ID=<test_group_chat_id>
   BUY_THRESHOLD_SOL=0.05
   ```
4. Run `npm start` and watch the logs. Buy a tiny amount of the test token
   yourself (or wait for organic trades) and confirm:
   - the listener logs "Qualifying buy detected"
   - the server logs the trigger, then "Video processing finished"
   - the server logs "Telegram send succeeded" and the video + caption show
     up in your test group with the right amount, wallet, and a working
     Solscan link
5. Try a buy *below* your threshold too, and confirm nothing fires — this
   catches off-by-one or unit mistakes (lamports vs. SOL) before they matter.
6. Only after that full round-trip works, edit `.env`:
   ```ini
   TOKEN_MINT_ADDRESS=<your real $EMBR mint>
   TELEGRAM_BOT_TOKEN=<your real bot token>
   TELEGRAM_CHAT_ID=<your real group chat id>
   BUY_THRESHOLD_SOL=5
   ```
   and restart (`npm start`). No code changes needed — it's purely a `.env`
   swap, which is the whole point of keeping these values out of the source.

### Notes / gotchas

- pump.fun's WebSocket schema can change; if `txType`/`solAmount` field
  names ever stop matching, temporarily log the raw message in
  `listener.js` (`console.log(raw.toString())`) to see the current shape.
- If ffmpeg errors with a font-related message, set `FONT_PATH` in `.env` to
  an absolute path to any `.ttf`/`.otf` file on your system.
- If ffmpeg errors with `No such filter: 'drawtext'`, your ffmpeg build
  wasn't compiled with `libfreetype` support. Check with
  `ffmpeg -filters | grep drawtext`. On macOS this can happen with a
  minimal Homebrew bottle — install `brew install ffmpeg-full` instead (or
  reinstall `ffmpeg`, which normally includes freetype) and make sure the
  one with drawtext support is first on your `PATH`.
- Treat your `TELEGRAM_BOT_TOKEN` like a password — rotate it via
  @BotFather (`/revoke`) if it ever leaks.
