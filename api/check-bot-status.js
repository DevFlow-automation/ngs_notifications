import { neon } from '@neondatabase/serverless';
import { Bot } from 'grammy';
import { authenticateRequest } from '../lib/auth.js';
import {
    classifyTelegramError,
    ensureBotStatusColumns,
    updateBotStatusesBatch
} from '../lib/botStatus.js';

const sql = neon(process.env.DATABASE_URL);
const bot = new Bot(process.env.BOT_TOKEN);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
    }

    const auth = authenticateRequest(req);
    if (!auth.authenticated) {
        return res.status(401).json({ status: 'error', message: 'Требуется авторизация через Telegram' });
    }
    if (auth.role !== 'admin') {
        return res.status(403).json({ status: 'error', message: 'Доступно только администратору' });
    }

    try {
        await ensureBotStatusColumns(sql);
        const rows = await sql`SELECT DISTINCT telegram_id FROM parents WHERE telegram_id IS NOT NULL`;
        const parentIds = rows.map(r => String(r.telegram_id)).filter(Boolean);

        const BATCH_SIZE = 25;
        const BATCH_INTERVAL_MS = 1000;
        const statusByTgId = new Map();
        const counts = {
            total: parentIds.length,
            active: 0,
            blocked: 0,
            not_started: 0,
            deactivated: 0,
            errors: 0
        };

        const checkOne = async (pid) => {
            try {
                // sendChatAction не отправляет сообщений родителю, но точно проверяет доступность чата
                await bot.api.sendChatAction(pid, 'typing');
                return { pid, status: 'active' };
            } catch (err) {
                const retryAfter = err?.parameters?.retry_after;
                if (err?.error_code === 429 && retryAfter) {
                    await new Promise(resolve => setTimeout(resolve, (retryAfter + 0.5) * 1000));
                    try {
                        await bot.api.sendChatAction(pid, 'typing');
                        return { pid, status: 'active' };
                    } catch (retryErr) {
                        return { pid, status: classifyTelegramError(retryErr), err: retryErr };
                    }
                }
                return { pid, status: classifyTelegramError(err), err };
            }
        };

        for (let i = 0; i < parentIds.length; i += BATCH_SIZE) {
            const batchStart = Date.now();
            const batch = parentIds.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(checkOne));

            for (const r of results) {
                if (r.status) {
                    statusByTgId.set(r.pid, r.status);
                    if (counts[r.status] !== undefined) counts[r.status]++;
                } else {
                    counts.errors++;
                    console.error(`Неизвестная ошибка проверки статуса ${r.pid}:`, r.err?.message || r.err);
                }
            }

            if (i + BATCH_SIZE < parentIds.length) {
                const waitMs = Math.max(0, BATCH_INTERVAL_MS - (Date.now() - batchStart));
                if (waitMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
            }
        }

        await updateBotStatusesBatch(sql, statusByTgId);

        return res.status(200).json({ status: 'success', ...counts });
    } catch (error) {
        console.error('Ошибка проверки статусов бота:', error);
        return res.status(500).json({ status: 'error', message: 'Ошибка проверки статусов бота' });
    }
}
