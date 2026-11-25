import { neon } from '@neondatabase/serverless';
import { Bot } from 'grammy';
import { authenticateRequest, VALID_CLASSES } from '../lib/auth.js';
import {
    classifyTelegramError,
    ensureBotStatusColumns,
    updateBotStatusSingle
} from '../lib/botStatus.js';

const sql = neon(process.env.DATABASE_URL);
const bot = new Bot(process.env.BOT_TOKEN);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });

    const auth = authenticateRequest(req);
    if (!auth.authenticated || !auth.userId) {
        return res.status(401).json({ status: 'error', message: 'Откройте анкету через Telegram-бот' });
    }

    const userId = auth.userId;
    const parentName = String(req.body?.parent_full_name || '').trim().slice(0, 200);
    const childName = String(req.body?.child_full_name || '').trim().slice(0, 200);
    const schoolClass = String(req.body?.school_class || '').trim().toUpperCase();
    const phone = String(req.body?.phone || '').trim().slice(0, 50);
    const email = String(req.body?.email || 'Не указан').trim().slice(0, 200) || 'Не указан';
    const address = String(req.body?.address || 'Не указан').trim().slice(0, 300) || 'Не указан';

    if (!parentName || !childName || !phone || !VALID_CLASSES.has(schoolClass)) {
        return res.status(400).json({ status: 'error', message: 'Заполните корректно ФИО, телефон и класс' });
    }

    try {
        // Проверяем, не зарегистрирован ли уже этот пользователь
        const existing = await sql`SELECT id FROM parents WHERE telegram_id = ${userId} LIMIT 1`;

        if (existing.length > 0) {
            return res.status(400).json({ status: 'error', message: 'Вы уже зарегистрированы!' });
        }

        await ensureBotStatusColumns(sql);

        // Сохраняем в базу (student_status по умолчанию 'present')
        await sql`
            INSERT INTO parents (telegram_id, parent_full_name, child_full_name, school_class, phone, email, address, student_status, bot_status, bot_status_updated_at)
            VALUES (${userId}, ${parentName}, ${childName}, ${schoolClass}, ${phone}, ${email}, ${address}, 'present', 'unknown', NOW())
        `;

        // Отправляем уведомление в бот и фиксируем статус доступности
        try {
            await bot.api.sendMessage(userId, "Регистрация успешно завершена! Теперь вы будете получать оповещения.");
            await updateBotStatusSingle(sql, userId, 'active').catch(() => {});
        } catch (botError) {
            console.error(`Не удалось отправить сообщение ${userId}:`, botError);
            const classified = classifyTelegramError(botError) || 'not_started';
            await updateBotStatusSingle(sql, userId, classified).catch(() => {});
        }

        return res.status(200).json({ status: 'success' });
    } catch (error) {
        console.error('Ошибка при регистрации:', error);
        return res.status(500).json({ status: 'error', message: 'Ошибка БД. Попробуйте еще раз.' });
    }
}
