import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import pino from 'pino';
import { 
    makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore, 
    Browsers, 
    jidNormalizedUser 
} from '@whiskeysockets/baileys';

const router = express.Router();
const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'error' : 'info' });

const SESSION_TIMEOUT = 300000; // 5 minutes
const RECONNECT_INTERVAL = 5000;

async function cleanupSession(dir) {
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
        logger.error(`Error cleaning up session: ${error.message}`);
    }
}

function formatPhoneNumber(num) {
    // Remove all non-digit characters except plus sign
    let formatted = num.replace(/[^\d+]/g, '');
    
    // Remove leading + if present
    if (formatted.startsWith('+')) {
        formatted = formatted.substring(1);
    }
    
    // Add default country code if missing
    if (!formatted.match(/^[1-9]\d{1,2}/)) {
        formatted = '62' + formatted;
    }
    
    return formatted;
}

router.get('/', async (req, res) => {
    try {
        let { number } = req.query;
        
        if (!number) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        const sessionDir = path.join(process.cwd(), `session_${number}`);
        await cleanupSession(sessionDir);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const socketConfig = {
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger.child({ level: 'fatal' })),
            },
            printQRInTerminal: false,
            logger: logger.child({ level: 'fatal' }),
            browser: Browsers.windows('Firefox'),
            connectTimeout: SESSION_TIMEOUT
        };

        const sock = makeWASocket(socketConfig);

        // Handle pairing if not registered
        if (!sock.authState.creds.registered) {
            await delay(2000);
            number = formatPhoneNumber(number);
            
            try {
                const code = await sock.requestPairingCode(number);
                return res.json({ 
                    status: 'pairing', 
                    pairingCode: code,
                    message: 'Please enter this pairing code in your WhatsApp app'
                });
            } catch (error) {
                logger.error(`Pairing error: ${error.message}`);
                await cleanupSession(sessionDir);
                return res.status(500).json({ error: 'Failed to generate pairing code' });
            }
        }

        // Event handlers
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                logger.info('Connection established');
                
                try {
                    const userJid = jidNormalizedUser(`${number}@s.whatsapp.net`);
                    const credsPath = path.join(sessionDir, 'creds.json');
                    
                    // Delay to ensure everything is ready
                    await delay(5000);
                    
                    // Send session file
                    const sessionData = await fs.readFile(credsPath);
                    await sock.sendMessage(userJid, { 
                        document: sessionData, 
                        mimetype: 'application/json', 
                        fileName: 'creds.json' 
                    });
                    
                    // Send informational messages
                    await sock.sendMessage(userJid, { 
                        text: `*Important Instructions*\n\n` +
                              `🔒 Keep your session file secure\n` +
                              `☠️ NEVER SHARE WITH ANYONE\n\n` +
                              `Contact developer: wa.me/263777124998` 
                    });
                    
                    // Cleanup
                    await delay(1000);
                    await cleanupSession(sessionDir);
                    process.exit(0);
                    
                } catch (error) {
                    logger.error(`Session transfer error: ${error.message}`);
                    await cleanupSession(sessionDir);
                    process.exit(1);
                }
            }
            
            if (connection === "close") {
                if (lastDisconnect?.error?.output?.statusCode !== 401) {
                    logger.info('Attempting to reconnect...');
                    await delay(RECONNECT_INTERVAL);
                    router.get('/', req, res); // Reinitiate session
                } else {
                    logger.error('Authentication failed, please restart');
                    await cleanupSession(sessionDir);
                }
            }
        });
        
        // Set timeout for session initialization
        setTimeout(async () => {
            if (!sock.authState.creds.registered) {
                logger.warn('Session initialization timed out');
                await cleanupSession(sessionDir);
                if (!res.headersSent) {
                    res.status(408).json({ error: 'Session initialization timed out' });
                }
            }
        }, SESSION_TIMEOUT);

    } catch (error) {
        logger.error(`Initialization error: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to initialize session' });
        }
    }
});

// Error handling
process.on('uncaughtException', (error) => {
    const ignoreErrors = [
        "conflict",
        "not-authorized",
        "Socket connection timeout",
        "rate-overlimit",
        "Connection Closed",
        "Timed Out",
        "Value not found"
    ];
    
    if (!ignoreErrors.some(e => error.message.includes(e))) {
        logger.fatal(`Uncaught Exception: ${error.message}`);
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

export default router;
