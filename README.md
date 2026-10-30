# WhatsApp Polling Bot — Baileys edition (no Chrome)

## Replace files in your existing GitHub repository

1. Back up the existing `bot.js` and `sessions.json` locally.
2. Replace **bot.js** and **package.json**, and add/update **.gitignore** from this package.
3. If you have an existing `package-lock.json` generated for `whatsapp-web.js`, run `npm install` locally to regenerate it, and commit the new lockfile. Do not commit credentials.
4. On Render, set `ADMIN_PASSWORD` to a long random secret (at least 12 chars), `ADMIN_USER` to `admin` (optional), and `NODE_VERSION` to `24.22.1`.
5. Remove `PUPPETEER_CACHE_DIR` if previously configured (no longer needed).
6. Set Build Command `npm install` and Start Command `npm start`.
7. Deploy. Open `https://whatsapp-polling-bot.onrender.com/login` and enter your Basic Auth username/password.
8. Scan the shown QR using WhatsApp > Linked Devices > Link a Device. The QR updates automatically.
9. Send `!help` inside a WhatsApp group, then test `!poll Where to eat?`, `!add Sushi`, `!add Korean BBQ`, `!options`, `!start`.

## Run locally

```bash
npm install
ADMIN_PASSWORD='replace-with-a-long-password' npm start
```

Open http://localhost:10000/login with browser. Use `admin` as username.

## Compatibility notes

- **The old `.wwebjs_auth` cannot be reused**. Baileys creates `baileys_auth` and requires new WhatsApp pairing.
- **The old `sessions.json` draft format is compatible** if you copy the file into the same directory; creator IDs for WhatsApp users may have changed in some group types. If creator commands fail, cancel/recreate the affected draft with the original setup or move it to a fresh one, preserving a backup.
- **Local credentials are not persistent on Render Free.** A spin-down, restart or redeploy deletes `baileys_auth` and `sessions.json`. For actual lasting data and login, migrate both to a persistent external store (especially Signal session keys). Do not commit them or put them in Render environment variables manually.
- The `/health` endpoint is liveness only (always 200); `/ready` is bot connection readiness (503 unless connected), and `/login` and `/api/status` require Basic authentication. Set Render health-check path to `/health` while troubleshooting.
- Unlike the previous bot's `message_create` listener, Baileys event forwarding of messages sent from your phone can vary by WhatsApp version. If your own `!help` isn't detected, first test from another member's account in the group and check the logs. Incoming group commands should work.
- Native polls can be created, but WhatsApp is a third-party service and it may limit or change behavior.
- Baileys is unofficial; using it may violate WhatsApp terms or lead to account restrictions. Use a separate test account.

## Commands

`!poll <question>`: new draft; `!add <option>`: add; `!remove <number or name>`: remove own suggestion or any as creator; `!options`: list; `!start`: publish poll creator-only; `!cancel`: cancel creator-only; `!extend`: explains indefinite drafting; `!help`: list all.
