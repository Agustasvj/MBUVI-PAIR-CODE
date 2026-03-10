const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { makeid } = require('./id');
const {
    default: Mbuvi_Tech,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys');
const router = express.Router();
const sessionDir = path.join(__dirname, "temp");

function removeFile(path) {
    if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true });
}

router.get('/', async (req, res) => {
    const id = makeid();
    const num = (req.query.number || '').replace(/[^0-9]/g, '');
    if (!num) {
        return res.json({ code: "Please provide a phone number" });
    }
    const tempDir = path.join(sessionDir, id);
    let responseSent = false;

    async function startPairing() {
        let attempts = 0;
        const maxAttempts = 3; // Prevent infinite loops

        while (attempts < maxAttempts) {
            attempts++;
            try {
                const { version } = await fetchLatestWaWebVersion();
                const { state, saveCreds } = await useMultiFileAuthState(tempDir);
                const sock = Mbuvi_Tech({
                    version,
                    logger: pino({ level: "silent" }),
                    printQRInTerminal: false,
                    auth: {
                        creds: state.creds,
                        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
                    },
                    browser: ["Ubuntu", "Chrome", "20.0.04"],
                    markOnlineOnConnect: true
                });

                sock.ev.on('creds.update', saveCreds);

                const isInitialPairing = !sock.authState.creds.registered;

                if (isInitialPairing) {
                    await delay(2000);
                    const code = await sock.requestPairingCode(num);
                    const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                    if (!responseSent && !res.headersSent) {
                        res.json({ code: formatted });
                        responseSent = true;
                    }
                }

                sock.ev.on("connection.update", async (update) => {
                    const { connection, lastDisconnect } = update;
                    if (connection === "open") {
                        console.log("WhatsApp connected");

                        if (isInitialPairing) {
                            console.log("Initial pairing complete - awaiting restart close, no export yet");
                            // Skip export/send here; let 515 close happen
                            await delay(1000); // Short wait for stability
                            return;
                        }

                        // Stable connection: Export and send
                        try {
                            await sock.sendMessage(sock.user.id, { text: "Generating your session ID..." });
                        } catch (sendErr) {
                            console.error("Error sending generating message:", sendErr);
                        }

                        await delay(1000); // Short delay
                        await saveCreds(); // Force sync before export

                        const session = Buffer.from(
                            JSON.stringify({
                                creds: sock.authState.creds,
                                keys: state.keys
                            })
                        ).toString("base64");

                        try {
                            const sentSession = await sock.sendMessage(sock.user.id, { text: session });
                            const info = `
╔════════════════════◇
║ SESSION CONNECTED
║ MBUVI-MD
╚════════════════════╝
Copy the session above and set:
SESSION_ID=<your session>
in your bot environment.
`;
                            await sock.sendMessage(sock.user.id, { text: info }, { quoted: sentSession });
                            console.log("Session sent successfully");
                        } catch (sendErr) {
                            console.error("Error sending session/info:", sendErr);
                        }

                        await delay(1000);
                        sock.ws.close();
                        removeFile(tempDir);
                    } else if (connection === "close") {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        if (statusCode !== 401) { // 401 = logged out
                            console.log(`Reconnecting (attempt ${attempts})...`);
                            await delay(5000);
                            // Continue loop for reconnect
                        } else {
                            console.log("Connection closed permanently (logged out)");
                            removeFile(tempDir);
                            break; // Exit loop
                        }
                    }
                });
            } catch (err) {
                console.error("Pairing error:", err);
                removeFile(tempDir);
                if (!responseSent && !res.headersSent) {
                    res.json({ code: "Service Unavailable" });
                }
                break; // Exit on error
            }
        }
        if (attempts >= maxAttempts) {
            console.log("Max reconnect attempts reached");
            removeFile(tempDir);
        }
    }

    startPairing();
});

module.exports = router;
