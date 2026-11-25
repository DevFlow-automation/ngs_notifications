import { neon } from '@neondatabase/serverless';
import { Bot } from 'grammy';

const sql = neon(process.env.DATABASE_URL);
const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_IDS = [8771384583, 229049117]; 
const DEPUTY_IDS = [387863654, 21900086, 87180537, 32542185, 1759984801, 11763622, 1176641277, 117636223, 219000864,875096987];
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
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Method Not Allowed" });

    const { target_type, target_value, text, user_id } = req.body;
    const statusTargets = ['sick', 'excused', 'unexcused', 'late'];

    try {
        let parentIds = [];

        // Логика выборки получателей из базы
        if (target_type === 'all') {
            const rows = await sql`SELECT DISTINCT telegram_id FROM parents`;
            parentIds = rows.map(r => r.telegram_id);
        } else if (statusTargets.includes(target_type)) {
            const rows = await sql`SELECT DISTINCT telegram_id FROM parents WHERE student_status = ${target_type}`;
            parentIds = rows.map(r => r.telegram_id);
        } else if (target_type === 'class') {
            const rows = await sql`SELECT DISTINCT telegram_id FROM parents WHERE school_class = ${target_value}`;
            parentIds = rows.map(r => r.telegram_id);
        } else if (target_type === 'student') {
            parentIds = [parseInt(target_value, 10)];
        } else {
            return res.status(400).json({ status: "error", message: "Неверный тип рассылки" });
        }

        if (parentIds.length === 0) {
            return res.status(400).json({ status: "error", message: "Нет получателей в этой категории" });
        }

        // 1. Создаем запись в истории сообщений и получаем её ID (RETURNING id)
       const msgResult = await sql`
            INSERT INTO history (sender_id, recipient_id, message_text, timestamp)
            VALUES (${user_id}, ${target_value}, ${text}, NOW())
            RETURNING id
        `;
        const newMsgId = msgResult[0].id;

        let successCount = 0;
        let failedCount = 0;
        const unreachableIds = [];
        const replyMarkup = {
            inline_keyboard: [[{ text: "Ознакомлен ✅", callback_data: `ack_${newMsgId}` }]]
        };

        // 2. Делаем рассылку пачками (до 25 сообщений/сек — в пределах лимита Telegram 30 msg/sec)
        const BATCH_SIZE = 25;
        const BATCH_INTERVAL_MS = 1000;

        const sendToParent = async (pid) => {
            try {
                await bot.api.sendMessage(pid, text, { reply_markup: replyMarkup });
                return { ok: true };
            } catch (err) {
                const retryAfter = err?.parameters?.retry_after;
                if (err?.error_code === 429 && retryAfter) {
                    await new Promise(resolve => setTimeout(resolve, (retryAfter + 0.5) * 1000));
                    try {
                        await bot.api.sendMessage(pid, text, { reply_markup: replyMarkup });
                        return { ok: true };
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
                } else {
                    failedCount++;
                    const code = r.err?.error_code;
                    if (code === 403 || code === 400) {
                        unreachableIds.push(`${r.pid} (${code})`);
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

        if (unreachableIds.length > 0) {
            console.warn(`Недоставлено (бот заблокирован/удалён/чат не найден, ${unreachableIds.length} шт.): ${unreachableIds.join(', ')}`);
        }

        return res.status(200).json({ status: "success", count: successCount, failed: failedCount });
    } catch (error) {
        console.error("Ошибка при рассылке:", error);
        return res.status(500).json({ status: "error", message: "Ошибка БД при рассылке." });
    }
}
