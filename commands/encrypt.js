const fs = require('fs');
const path = require('path');
const os = require('os');
const JsConfuser = require('js-confuser');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { createFakeContact } = require('../lib/fakeContact');

// ─────────────────────────────────────────────────────────────────────────
// .encrypt — supports BOTH input modes:
//   1. Reply to a .js file with `.encrypt`  → downloads, obfuscates, sends
//      back as a .js document with the same filename.
//   2. `.encrypt <inline JavaScript>`        → obfuscates the pasted code,
//      sends back as a .js document.
// Either way the output is delivered as a downloadable file.
// ─────────────────────────────────────────────────────────────────────────

const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MB

const OBFUSCATE_OPTS = {
    target: 'node',
    preset: 'high',
    compact: true,
    minify: true,
    flatten: true,
    renameVariables: true,
    renameGlobals: true,
    stringEncoding: true,
    stringSplitting: 0.0,
    stringConcealing: true,
    stringCompression: true,
    duplicateLiteralsRemoval: 1.0,
    shuffle: { hash: 0.0, true: 0.0 },
    stack: true,
    controlFlowFlattening: 1.0,
    opaquePredicates: 0.9,
    deadCode: 0.0,
    dispatcher: true,
    rgf: false,
    calculator: true,
    hexadecimalNumbers: true,
    movedDeclarations: true,
    objectExtraction: true,
    globalConcealing: true,
    identifierGenerator: () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        let out = '_adevos_';
        for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
        return out;
    },
};

function extractInlineCode(message) {
    // Grab whatever text body the message has, then strip the command prefix.
    const raw =
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        '';
    return raw.replace(/^\s*[.!#/]?\s*(encrypt|enc|obfs|obfuscate)\b\s*/i, '').trim();
}

async function downloadQuotedJs(quotedMsg) {
    const doc = quotedMsg?.documentMessage;
    if (!doc) return null;
    const fileName = doc.fileName || 'input.js';
    if (!fileName.toLowerCase().endsWith('.js')) {
        throw new Error('Quoted file is not a .js file');
    }
    const stream = await downloadContentFromMessage(doc, 'document');
    let buf = Buffer.from([]);
    for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
    if (!buf.length) throw new Error('Downloaded file was empty');
    if (buf.length > MAX_INPUT_BYTES) throw new Error('File too large (max 5 MB)');
    return { code: buf.toString('utf8'), fileName, size: buf.length };
}

async function encryptCommand(sock, chatId, message, isOwner) {
    const fake = createFakeContact(message);
    let phase = 'init';

    try {
        // React: working
        await sock.sendMessage(chatId, { react: { text: '🔐', key: message.key } });

        // ── 1. Decide input source ──────────────────────────────────────
        const quotedMsg = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        let originalCode = '';
        let fileName = '';
        let originalSize = 0;
        let sourceLabel = '';

        if (quotedMsg?.documentMessage) {
            phase = 'download';
            const fileInfo = await downloadQuotedJs(quotedMsg);
            originalCode = fileInfo.code;
            fileName = fileInfo.fileName;
            originalSize = fileInfo.size;
            sourceLabel = '📄 quoted file';
        } else {
            const inline = extractInlineCode(message);
            if (inline) {
                originalCode = inline;
                fileName = `inline_${Date.now()}.js`;
                originalSize = Buffer.byteLength(inline, 'utf8');
                sourceLabel = '✏️ inline code';
                if (originalSize > MAX_INPUT_BYTES) {
                    throw new Error('Pasted code too large (max 5 MB)');
                }
            } else {
                // Neither a quoted file nor inline code → show help
                await sock.sendMessage(chatId, {
                    text:
                        '🔐 *Encrypt Command Usage*\n\n' +
                        '*Two ways to use this:*\n' +
                        '1️⃣  Reply to a `.js` file with `.encrypt`\n' +
                        '2️⃣  `.encrypt <paste your JavaScript here>`\n\n' +
                        'In both cases the obfuscated result is sent back as a `.js` file.\n\n' +
                        '✨ *Features:*\n' +
                        '• Variable & global renaming\n' +
                        '• String encoding + concealing\n' +
                        '• Control-flow flattening\n' +
                        '• Calculator + opaque predicates',
                }, { quoted: fake });
                await sock.sendMessage(chatId, { react: { text: 'ℹ️', key: message.key } });
                return;
            }
        }

        // ── 2. Status ───────────────────────────────────────────────────
        await sock.sendMessage(chatId, {
            text: `⚙️ *Obfuscating...*\n${sourceLabel}\n📦 ${(originalSize / 1024).toFixed(2)} KB`,
        }, { quoted: fake });

        // ── 3. Obfuscate ────────────────────────────────────────────────
        phase = 'obfuscate';
        const obfuscatedCode = await JsConfuser.obfuscate(originalCode, OBFUSCATE_OPTS);
        const obfuscatedSize = Buffer.byteLength(obfuscatedCode, 'utf8');
        const sizeRatio = (obfuscatedSize / Math.max(originalSize, 1) * 100).toFixed(1);

        // ── 4. Send file back ───────────────────────────────────────────
        phase = 'send';
        await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
        await sock.sendMessage(chatId, {
            document: Buffer.from(obfuscatedCode, 'utf8'),
            mimetype: 'application/javascript',
            fileName,
            caption:
                `🔐 *Encryption Complete*\n\n` +
                `📄 File: ${fileName}\n` +
                `📦 Original: ${(originalSize / 1024).toFixed(2)} KB\n` +
                `📦 Obfuscated: ${(obfuscatedSize / 1024).toFixed(2)} KB\n` +
                `📈 Ratio: ${sizeRatio}%\n` +
                `🛠 Source: ${sourceLabel}\n` +
                `👑 *@adevosX*`,
        }, { quoted: fake });

        if (isOwner) {
            const sender = message.key.participant || message.key.remoteJid;
            console.log(`[encrypt] ${fileName} ${(originalSize / 1024).toFixed(1)}→${(obfuscatedSize / 1024).toFixed(1)} KB by ${sender}`);
        }

    } catch (error) {
        console.error(`[encrypt] failed during ${phase}:`, error);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } }); } catch {}

        let msg = `🚫 *Encryption Error:* ${error.message || 'unknown'}`;
        const m = (error.message || '').toLowerCase();
        if (m.includes('syntax') || m.includes('unexpected')) {
            msg = '❌ *Syntax Error*\nThe JavaScript you provided has syntax errors and cannot be obfuscated.';
        } else if (m.includes('download') || m.includes('empty')) {
            msg = '❌ *Download Failed*\nCould not retrieve the quoted file. Try again.';
        } else if (m.includes('too large')) {
            msg = '❌ *Too Large*\nMax input size is 5 MB.';
        } else if (m.includes('not a .js')) {
            msg = '❌ *Wrong File Type*\nOnly `.js` files are supported.';
        } else if (m.includes('timeout')) {
            msg = '⏱️ *Timeout*\nThe code is too complex — try a simpler input.';
        }

        try {
            await sock.sendMessage(chatId, { text: msg }, { quoted: fake });
        } catch {}
    }
}

module.exports = encryptCommand;
