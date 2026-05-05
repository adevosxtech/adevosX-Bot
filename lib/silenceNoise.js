// ─────────────────────────────────────────────────────────────────────────
// silenceNoise.js — suppress known-noisy stdout/stderr lines from baileys
// + libsignal so the bot console stays readable.
//
// MUST be required as the FIRST line in index.js (before any other require)
// so the patches are in place BEFORE baileys loads and starts logging.
//
// We only suppress KNOWN-CHATTY substrings. Anything we don't recognise is
// still printed normally so real errors remain visible.
// ─────────────────────────────────────────────────────────────────────────

const SUPPRESS_PATTERNS = [
    // libsignal session churn (the loudest offender on busy chats)
    'Closing session: SessionEntry',
    'Closing open session',
    'Closing stale open session',
    'SessionEntry {',
    'Removing pre-key',
    'pre-key not found',
    'Bad MAC',

    // Decryption misses for old/missing keys (harmless, retried automatically)
    'Failed to decrypt',
    'Could not decrypt',
    'No matching sessions found for message',
    'No SenderKeyRecord',
    'No session record',

    // Baileys low-level chatter that pino-silent doesn't always swallow
    'logging in...',
    'opened connection to WA',
    'connection.update',

    // Newsletter / group auto-join idempotent success spam
    '✅ Auto-followed newsletter successfully',
    '✅ Auto-joined group successfully',

    // Per-connect full-user JSON dump (noise, not branding)
    '💅Connected to =>',
];

function shouldSuppress(message) {
    if (typeof message !== 'string' || message.length === 0) return false;
    for (let i = 0; i < SUPPRESS_PATTERNS.length; i++) {
        if (message.indexOf(SUPPRESS_PATTERNS[i]) !== -1) return true;
    }
    return false;
}

function patchWriter(stream) {
    const orig = stream.write.bind(stream);
    stream.write = function (chunk, encoding, callback) {
        try {
            const text = typeof chunk === 'string' ? chunk : chunk.toString();
            if (shouldSuppress(text)) {
                if (typeof encoding === 'function') encoding();
                else if (typeof callback === 'function') callback();
                return true;
            }
        } catch (_) { /* fall through to original write */ }
        return orig(chunk, encoding, callback);
    };
}

function patchConsole(method) {
    const orig = console[method];
    console[method] = function (...args) {
        if (args.length > 0 && typeof args[0] === 'string' && shouldSuppress(args[0])) {
            return;
        }
        return orig.apply(console, args);
    };
}

patchWriter(process.stdout);
patchWriter(process.stderr);
patchConsole('log');
patchConsole('error');
patchConsole('warn');
patchConsole('info');

module.exports = { SUPPRESS_PATTERNS };
