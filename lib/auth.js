const crypto = require('node:crypto');

const ADMIN_IDS = [8771384583, 229049117];
const DEPUTY_IDS = [
    387863654, 21900086, 87180537, 32542185, 1759984801,
    11763622, 1176641277, 117636223, 219000864, 875096987
];
const TEACHERS = {
    593614259: "1А", 7475228092: "1Б", 165555820: "1В", 6759744115: "1Г",
    262935335: "2А", 2067119625: "2Б", 192592122: "2В", 261773072: "2Г",
    843534212: "3А", 83655322: "3Б", 1579165503: "3В", 1849602045: "3Г",
    389444120: "4А", 8300203162: "4Б", 132622662: "4В",
    267481288: "5А", 285756001: "5Б", 937544028: "5В",
    127589326: "6А", 905178719: "6Б",
    8885418064: "7А", 8099039998: "7Б", 144330475: "7В",
    241743825: "8А", 42760022: "8Б",
    1329417314: "9А", 124341010: "10А", 539135124: "11А"
};

const VALID_CLASSES = new Set([
    "1А", "1Б", "1В", "1Г",
    "2А", "2Б", "2В", "2Г",
    "3А", "3Б", "3В", "3Г",
    "4А", "4Б", "4В",
    "5А", "5Б", "5В",
    "6А", "6Б",
    "7А", "7Б", "7В",
    "8А", "8Б",
    "9А", "10А", "11А"
]);

const VALID_STUDENT_STATUSES = new Set(['present', 'sick', 'excused', 'unexcused', 'late']);

function getTokenSecret() {
    return process.env.EXPORT_TOKEN_SECRET || process.env.BOT_TOKEN || '';
}

function resolveRole(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
        return { role: 'none', teacherClass: null };
    }
    if (ADMIN_IDS.includes(id)) return { role: 'admin', teacherClass: null };
    if (DEPUTY_IDS.includes(id)) return { role: 'deputy', teacherClass: null };
    if (TEACHERS[id]) return { role: 'teacher', teacherClass: TEACHERS[id] };
    return { role: 'none', teacherClass: null };
}

function verifyTelegramInitData(initDataRaw) {
    const botToken = process.env.BOT_TOKEN;
    if (!initDataRaw || typeof initDataRaw !== 'string' || !botToken) return null;

    try {
        const params = new URLSearchParams(initDataRaw);
        const hash = params.get('hash');
        if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;

        const pairs = [];
        for (const [key, value] of params.entries()) {
            if (key === 'hash') continue;
            pairs.push(`${key}=${value}`);
        }
        pairs.sort();
        const dataCheckString = pairs.join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();

        const computed = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        const hashBuf = Buffer.from(hash, 'hex');
        const computedBuf = Buffer.from(computed, 'hex');
        if (hashBuf.length !== computedBuf.length) return null;
        if (!crypto.timingSafeEqual(hashBuf, computedBuf)) return null;

        const authDate = Number(params.get('auth_date') || 0);
        const nowSec = Math.floor(Date.now() / 1000);
        if (!authDate || nowSec - authDate > 86400 * 7 || authDate - nowSec > 300) {
            return null;
        }

        const userStr = params.get('user');
        if (!userStr) return null;
        const user = JSON.parse(userStr);
        if (!user || !Number.isInteger(Number(user.id)) || Number(user.id) <= 0) return null;

        return {
            user: { ...user, id: Number(user.id) },
            authDate
        };
    } catch {
        return null;
    }
}

function createExportToken(userId) {
    const secret = getTokenSecret();
    if (!secret || !userId) return '';
    const payload = {
        uid: Number(userId),
        purpose: 'export',
        exp: Date.now() + 1000 * 60 * 60 * 2 // 2 часа
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto
        .createHmac('sha256', secret)
        .update(encoded)
        .digest('base64url');
    return `${encoded}.${sig}`;
}

function verifyExportToken(token) {
    const secret = getTokenSecret();
    if (!secret || !token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [encoded, sig] = parts;
    const expected = crypto
        .createHmac('sha256', secret)
        .update(encoded)
        .digest('base64url');

    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (payload.purpose !== 'export' || !payload.exp || payload.exp < Date.now()) return null;
        const uid = Number(payload.uid);
        if (!Number.isInteger(uid) || uid <= 0) return null;
        return uid;
    } catch {
        return null;
    }
}

function authenticateRequest(req, { allowExportToken = false } = {}) {
    const rawHeader = req.headers?.['x-telegram-init-data'] || '';
    const initDataRaw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const verified = verifyTelegramInitData(initDataRaw);

    if (verified) {
        const { role, teacherClass } = resolveRole(verified.user.id);
        return {
            authenticated: true,
            userId: verified.user.id,
            tgUser: verified.user,
            role,
            teacherClass
        };
    }

    if (allowExportToken) {
        const token = String(req.query?.token || '');
        const tokenUid = verifyExportToken(token);
        if (tokenUid) {
            const { role, teacherClass } = resolveRole(tokenUid);
            return {
                authenticated: true,
                userId: tokenUid,
                tgUser: null,
                role,
                teacherClass
            };
        }
    }

    return {
        authenticated: false,
        userId: 0,
        tgUser: null,
        role: 'none',
        teacherClass: null
    };
}

function verifyWebhookSecret(req) {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) return true;
    const raw = req.headers?.['x-telegram-bot-api-secret-token'] || '';
    const headerVal = Array.isArray(raw) ? raw[0] : String(raw);
    const a = Buffer.from(headerVal);
    const b = Buffer.from(secret);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function sanitizeExcelCell(value) {
    if (value == null) return '';
    const str = String(value);
    if (!str) return '';
    // Обычные номера телефонов (+998..., +7...) оставляем читаемыми, но опасные формулы экранируем
    if (/^\+?\d[\d\s()-]{5,24}$/.test(str.trim())) {
        return str;
    }
    if (/^[=+\-@\t\r]/.test(str)) {
        return `'${str}`;
    }
    return str;
}

module.exports = {
    ADMIN_IDS,
    DEPUTY_IDS,
    TEACHERS,
    VALID_CLASSES,
    VALID_STUDENT_STATUSES,
    resolveRole,
    verifyTelegramInitData,
    createExportToken,
    verifyExportToken,
    authenticateRequest,
    verifyWebhookSecret,
    sanitizeExcelCell
};
