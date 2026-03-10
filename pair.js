const express = require('express')
const fs = require('fs')
const path = require('path')
const pino = require('pino')
const { makeid } = require('./id')

const {
    default: Mbuvi_Tech,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys')

const router = express.Router()
const sessionDir = path.join(__dirname, "temp")

function removeFile(path) {
    if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true })
}

router.get('/', async (req, res) => {

    const id = makeid()
    const num = (req.query.number || '').replace(/[^0-9]/g, '')

    if (!num) {
        return res.json({ code: "Please provide a phone number" })
    }

    const tempDir = path.join(sessionDir, id)

    let responseSent = false
    let sessionSent = false

    async function startPairing() {

        try {

            const { version } = await fetchLatestWaWebVersion()

            const { state, saveCreds } = await useMultiFileAuthState(tempDir)

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
            })

            sock.ev.on('creds.update', saveCreds)

            if (!sock.authState.creds.registered) {

                await delay(2000)

                const code = await sock.requestPairingCode(num)
                const formatted = code?.match(/.{1,4}/g)?.join("-") || code

                if (!responseSent && !res.headersSent) {
                    res.json({ code: formatted })
                    responseSent = true
                }

            }

            sock.ev.on("connection.update", async (update) => {

                const { connection, lastDisconnect } = update

                if (connection === "open") {

                    console.log("✅ WhatsApp connected")

                    try {

                        await sock.sendMessage(sock.user.id, {
                            text: "Generating your session ID..."
                        })

                    } catch {}

                    await delay(3000)

                    const session = Buffer.from(
                        JSON.stringify(sock.authState.creds)
                    ).toString("base64")

                    if (!sessionSent) {

                        sessionSent = true

                        const sentSession = await sock.sendMessage(sock.user.id, {
                            text: session
                        })

                        const infoMessage = `
╔════════════════════◇
║ SESSION CONNECTED
║ MBUVI-MD
╚════════════════════╝

Copy the session above and set:

SESSION_ID=<your session>

in your bot environment.
`

                        await sock.sendMessage(
                            sock.user.id,
                            { text: infoMessage },
                            { quoted: sentSession }
                        )

                    }

                    await delay(2000)

                    sock.ws.close()

                    removeFile(tempDir)

                }

                else if (connection === "close") {

                    if (lastDisconnect?.error?.output?.statusCode !== 401) {

                        console.log("⚠️ reconnecting...")

                        await delay(5000)

                        startPairing()

                    } else {

                        console.log("❌ connection closed permanently")

                        removeFile(tempDir)

                    }

                }

            })

        }

        catch (err) {

            console.log("❌ pairing error:", err)

            removeFile(tempDir)

            if (!responseSent && !res.headersSent) {
                res.json({ code: "Service Unavailable" })
            }

        }

    }

    startPairing()

})

module.exports = router
