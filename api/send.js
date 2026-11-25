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
    if (auth.role === 'none') {
        return res.status(403).json({ status: 'error', message: 'Нет доступа к рассылкам' });
    }

    const { target_type, target_value } = req.body || {};
    const text = String(req.body?.text || '').trim();
    const statusTargets = ['sick', 'excused', 'unexcused', 'late'];

    if (!text || text.length > 4096) {
        return res.status(400).json({ status: 'error', message: 'Текст сообщения должен быть от 1 до 4096 символов' });
    }

    // Ограничения прав для классного руководителя
    if (auth.role === 'teacher') {
        if (target_type !== 'class' && target_type !== 'student') {
            return res.status(403).json({ status: 'error', message: 'Учитель может отправлять сообщения только своему классу или ученику своего класса' });
        }
        if (target_type === 'class' && String(target_value || '').trim() !== auth.teacherClass) {
            return res.status(403).json({ status: 'error', message: 'Запрещена рассылка в чужой класс' });
        }
    }

    try {
        let parentIds = [];
        let recipientRecordValue = String(target_value || '');

        // Логика выборки получателей из базы
        if (target_type === 'all') {
            const rows = await sql`SELECT DISTINCT telegram_id FROM parents`;
            parentIds = rows.map(r => r.telegram_id);
            recipientRecordValue = 'all';
        } else if (statusTargets.includes(target_type)) {
            const rows = await sql`SELECT DISTINCT telegram_id FROM parents WHERE student_status = ${target_type}`;
            parentIds = rows.map(r => r.telegram_id);
            recipientRecordValue = target_type;
        } else if (target_type === 'class') {
            const targetClass = String(target_value || '').trim();
            if (!targetClass) return res.status(400).json({ status: 'error', message: 'Не указан класс' });
            const rows = await sql`SELECT DISTINCT telegram_id FROM parents WHERE school_class = ${targetClass}`;
            parentIds = rows.map(r => r.telegram_id);
            recipientRecordValue = targetClass;
        } else if (target_type === 'student') {
            const targetTgId = String(target_value || '').trim();
            if (!/^\d{5,15}$/.test(targetTgId)) {
                return res.status(400).json({ status: 'error', message: 'Некорректный получатель' });
            }
            if (auth.role === 'teacher') {
                const check = await sql`
                    SELECT 1 FROM parents
                    WHERE telegram_id = ${targetTgId} AND school_class = ${auth.teacherClass}
                    LIMIT 1
                `;
                if (check.length === 0) {
                    return res.status(403).json({ status: 'error', message: 'Этот родитель не относится к вашему классу' });
                }
            }
            parentIds = [targetTgId];
            recipientRecordValue = targetTgId;
        } else {
            return res.status(400).json({ status: 'error', message: 'Неверный тип рассылки' });
        }

        if (parentIds.length === 0) {
            return res.status(400).json({ status: 'error', message: 'Нет получателей в этой категории' });
        }

        // 1. Создаем запись в истории сообщений (sender_id берется строго из проверенного Telegram initData)
        const msgResult = await sql`
            INSERT INTO history (sender_id, recipient_id, message_text, timestamp)
            VALUES (${auth.userId}, ${recipientRecordValue}, ${text}, NOW())
            RETURNING id
        `;
        const newMsgId = msgResult[0].id;

        let successCount = 0;
        let failedCount = 0;
        const unreachableIds = [];
        const statusByTgId = new Map();
        const replyMarkup = {
            inline_keyboard: [[{ text: "Ознакомлен ✅", callback_data: `ack_${newMsgId}` }]]
        };

        // 2. Делаем рассылку пачками (до 25 сообщений/сек — в пределах лимита Telegram 30 msg/sec)
        const BATCH_SIZE = 25;
        const BATCH_INTERVAL_MS = 1000;

        const sendToParent = async (pid) => {
            try {
                await bot.api.sendMessage(pid, text, { reply_markup: replyMarkup });
                return { ok: true, pid };
            } catch (err) {
                const retryAfter = err?.parameters?.retry_after;
                if (err?.error_code === 429 && retryAfter) {
                    await new Promise(resolve => setTimeout(resolve, (retryAfter + 0.5) * 1000));
                    try {
                        await bot.api.sendMessage(pid, text, { reply_markup: replyMarkup });
                        return { ok: true, pid };
                    } catch (retryErr) {
                        return { ok: false, pid, err: retryErr };
                    }
                }
                return { ok: false, pid, err };
            }
        };

        for (let i = 0; i < parentIds.length; i += BATCH_SIZE) {
            const batchStart = Date.now();
            const batch = parentIds.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(sendToParent));

            for (const r of results) {
                if (r.ok) {
                    successCount++;
                    statusByTgId.set(String(r.pid), 'active');
                } else {
                    failedCount++;
                    const classified = classifyTelegramError(r.err);
                    if (classified) {
                        statusByTgId.set(String(r.pid), classified);
                        unreachableIds.push(`${r.pid} (${classified})`);
                    } else {
                        console.error(`Ошибка отправки пользователю ${r.pid}:`, r.err?.message || r.err);
                    }
                }
            }

            if (i + BATCH_SIZE < parentIds.length) {
                const waitMs = Math.max(0, BATCH_INTERVAL_MS - (Date.now() - batchStart));
                if (waitMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
            }
        }

        try {
            await ensureBotStatusColumns(sql);
            await updateBotStatusesBatch(sql, statusByTgId);
        } catch (statusErr) {
            console.error('Ошибка обновления bot_status после рассылки:', statusErr);
        }

        if (unreachableIds.length > 0) {
            console.warn(`Недоставлено (бот заблокирован/удалён/чат не найден, ${unreachableIds.length} шт.): ${unreachableIds.join(', ')}`);
        }

        const resp = { status: 'success', count: successCount };
        if (auth.role === 'admin') {
            resp.failed = failedCount;
        }
        return res.status(200).json(resp);
    } catch (error) {
        console.error('Ошибка при рассылке:', error);
        return res.status(500).json({ status: 'error', message: 'Ошибка БД при рассылке.' });
    }
}
