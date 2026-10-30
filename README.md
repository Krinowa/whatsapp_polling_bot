# WhatsApp group voting bot (starter)

This Node.js bot lets group members suggest up to 12 options, then posts a **native WhatsApp poll** after five minutes. It is a prototype built on the unofficial `whatsapp-web.js` library, **not** the official WhatsApp Business API. Use a spare WhatsApp account for testing, not your primary account. Accounts can be restricted for unofficial automation.

## Install and run (macOS)

Requires Node.js >=18, npm, internet, a phone with WhatsApp, and a normal WhatsApp group that includes the bot account.

```bash
cd whatsapp-voting-bot
npm install
npm start
```

On first start, scan the QR in the terminal using **WhatsApp on the bot phone > Settings > Linked Devices > Link a device**. The local authentication is kept in `.wwebjs_auth/`, which is sensitive. Keep it private and out of Git.

In the group, **from another member's account**, send:

```
!poll Where should we eat tonight?
!add Sushi
!add Korean BBQ
!options
!start
```

`!help` lists all commands. `!start` and `!cancel` are restricted to the person who sent `!poll`. Suggestions from all group members are accepted. At the deadline, if fewer than two suggestions exist, the poll is cancelled.

For faster testing, edit `const SUGGESTION_MINUTES = 5;` in `bot.js` to `1`.

## Notes

- You can only have one in-preparation poll per group, but different groups can run their own simultaneously.
- Suggestion sessions are saved to `sessions.json`; on restart after the bot is ready, pending/expired polls resume automatically. Do **not** edit the file while the bot is running.
- `!start` posts the native poll immediately when at least two options exist.
- The live vote totals are displayed by WhatsApp's own poll UI; this bot does not process, store, or announce results.
- Native WhatsApp polls cannot have new answer options appended by this bot after publishing. Suggestions are therefore collected **before** sending the poll.
- The bot runs only while this Node.js process and WhatsApp connection are available.
- It is a minimal prototype, not a hardened production service. A crash between sending a poll and saving completion could result in sending it a second time after restart.
- Group members who know the commands can start polls, so create a private test group before using more broadly.

## Troubleshooting

- **No QR code:** Check console for authenticated/ready messages; `LocalAuth` may already have a saved login.
- **Bot ignores commands:** Make sure the bot's WhatsApp account belongs to the group and commands are sent **from a different account**. Only normal group chats are processed.
- **No poll after five minutes:** Check the terminal for a send error; creator can retry with `!start`. Ensure at least two options were submitted.
- **Chrome/Puppeteer issues:** Ensure the dependencies install successfully; check the `whatsapp-web.js` installation guide for your OS.

Library: https://wwebjs.dev/guide/
