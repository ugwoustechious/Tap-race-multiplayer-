# Tap Race multiplayer (update)

Replace these 3 files in your GitHub repo (same places as before), then Render redeploys by itself:
- `server.js`  (repo root)
- `package.json`  (repo root)
- `public/index.html`  (the game; its SERVER_URL is already https://tap-race-server.onrender.com)

If you host the game page somewhere else, upload `public/index.html` there too.

What's new
- Racer names (required, 12 letters max, remembered on the phone).
- "Open games" list: create a game and it shows up live for everyone. Tap it to join. No code needed.
- Private game option (code only), and joining by code still works.
- Same start moment for everyone: the server sets the start time and each phone corrects for its own clock.
- Reconnect: if a phone sleeps or switches apps, it takes its seat back.
- Back to lobby after a race for a rematch. Host passes to the next player if the host leaves.
- Server checks taps, so nobody can fake a finish.
