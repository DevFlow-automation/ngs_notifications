const ADMIN_IDS = [8771384583, 229049117];

const BOT_STATUS_LABELS = {
    active: 'Бот активен',
    blocked: 'Заблокировал бота',
    not_started: 'Не запускал бота',
    deactivated: 'Аккаунт удалён',
    unknown: 'Не проверен'
};

let columnsEnsured = false;

async function ensureBotStatusColumns(sql) {
    if (columnsEnsured) return;
    await sql`ALTER TABLE parents ADD COLUMN IF NOT EXISTS bot_status TEXT DEFAULT 'unknown'`;
    await sql`ALTER TABLE parents ADD COLUMN IF NOT EXISTS bot_status_updated_at TIMESTAMPTZ`;
    columnsEnsured = true;
}

function classifyTelegramError(err) {
    const code = Number(err?.error_code || 0);
    const desc = String(err?.description || err?.message || '').toLowerCase();

    if (code === 403) {
        if (desc.includes('blocked')) return 'blocked';
        if (desc.includes('deactivated')) return 'deactivated';
        if (desc.includes('initiate')) return 'not_started';
        return 'blocked';
    }

    if (code === 400) {
        if (
            desc.includes('chat not found') ||
            desc.includes('user not found') ||
            desc.includes('peer_id_invalid') ||
            desc.includes('chat_id is empty')
        ) {
            return 'not_started';
        }
    }

    return null;
}

async function updateBotStatusSingle(sql, telegramId, status) {
    if (!telegramId || !status) return;
    await ensureBotStatusColumns(sql);
    await sql`
        UPDATE parents
        SET bot_status = ${status},
            bot_status_updated_at = NOW()
        WHERE telegram_id = ${String(telegramId)}
    `;
}

async function updateBotStatusesBatch(sql, statusByTgId) {
    if (!statusByTgId || statusByTgId.size === 0) return;
    await ensureBotStatusColumns(sql);

    const groups = new Map();
    for (const [tgId, status] of statusByTgId.entries()) {
        if (!status) continue;
        const idStr = String(tgId).trim();
        if (!/^-?\d+$/.test(idStr)) continue;
        if (!groups.has(status)) groups.set(status, []);
        groups.get(status).push(idStr);
    }

    for (const [status, ids] of groups.entries()) {
        if (ids.length === 0) continue;
        await sql`
            UPDATE parents
            SET bot_status = ${status},
                bot_status_updated_at = NOW()
            WHERE telegram_id = ANY(${ids}::bigint[])
        `;
    }
}

module.exports = {
    ADMIN_IDS,
    BOT_STATUS_LABELS,
    ensureBotStatusColumns,
    classifyTelegramError,
    updateBotStatusSingle,
    updateBotStatusesBatch
};
