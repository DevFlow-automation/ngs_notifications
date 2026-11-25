import { neon } from '@neondatabase/serverless';
import { Bot } from 'grammy';
import {
    classifyTelegramError,
    ensureBotStatusColumns,
    updateBotStatusSingle
} from '../lib/botStatus.mjs';

const sql = neon(process.env.DATABASE_URL);
const bot = new Bot(process.env.BOT_TOKEN);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Method Not Allowed" });

    const { user_id, parent_full_name, child_full_name, school_class, phone, email, address } = req.body;

    try {
        // Проверяем, не зарегистрирован ли уже этот пользователь
        const existing = await sql`SELECT id FROM parents WHERE telegram_id = ${user_id} LIMIT 1`;

        if (existing.length > 0) {
            return res.status(400).json({ status: "error", message: "Вы уже зарегистрированы!" });
        }

        await ensureBotStatusColumns(sql);

        // Сохраняем в базу (student_status по умолчанию 'present')
        await sql`
            INSERT INTO parents (telegram_id, parent_full_name, child_full_name, school_class, phone, email, address, student_status, bot_status, bot_status_updated_at)
            VALUES (${user_id}, ${parent_full_name}, ${child_full_name}, ${school_class}, ${phone}, ${email}, ${address}, 'present', 'unknown', NOW())
        `;

        // Отправляем уведомление в бот и фиксируем статус доступности
        try {
            await bot.api.sendMessage(user_id, "Регистрация успешно завершена! Теперь вы будете получать оповещения.");
            await updateBotStatusSingle(sql, user_id, 'active').catch(() => {});
        } catch (botError) {
            console.error(`Не удалось отправить сообщение ${user_id}:`, botError);
            const classified = classifyTelegramError(botError) || 'not_started';
            await updateBotStatusSingle(sql, user_id, classified).catch(() => {});
        }

        return res.status(200).json({ status: "success" });
    } catch (error) {
        console.error("Ошибка при регистрации:", error);
        return res.status(500).json({ status: "error", message: "Ошибка БД. Попробуйте еще раз." });
    }
}
