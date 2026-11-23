# Tap Race multiplayer (Render)

## Files
- `public/index.html` — your original notebook-style game with a multiplayer room/lobby screen.
- `server.js` — temporary room and real-time event server.
- `package.json` — Node dependencies and start command.

## 1. Deploy the server to Render
1. Create a GitHub repository and upload this project.
2. In Render, choose **New → Web Service** and connect the repository.
3. Set **Root Directory** to the project root (leave blank if this is the repository root).
4. Build command: `npm install`
5. Start command: `npm start`
6. Choose the Free instance if available on your account.
7. After deployment, copy the service URL, for example `https://tap-race-server.onrender.com`.

## 2. Connect the HTML to your Render URL
Open `public/index.html` and find:
`const SERVER_URL = "https://YOUR-RENDER-SERVICE.onrender.com";`
Replace it with your actual Render URL. Commit/push the change, or update the HTML wherever you host it.

## 3. Test
Open the game on two different devices/browsers. Tap **Multiplayer**, create a room on one device, enter the four-digit code on the other, and have the host start.

## Notes
- Room data is held in server memory. Rooms disappear when empty or when the server restarts.
- Render Free services may sleep when idle; the first connection after inactivity can take time.
- This is a first playable multiplayer foundation. It supports up to four players and room codes. Before public launch, add reconnect handling, proper finish-order timestamps, rate limiting, and stronger server-side validation.
- The original solo mode and notebook styling are retained.
