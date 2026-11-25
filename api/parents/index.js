import { neon } from '@neondatabase/serverless';
import { authenticateRequest, VALID_CLASSES } from '../../lib/auth.js';
import { ensureBotStatusColumns } from '../../lib/botStatus.js';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
    const auth = authenticateRequest(req);
    if (!auth.authenticated) {
        return res.status(401).json({ status: 'error', error: 'Требуется авторизация через Telegram' });
    }
    if (auth.role === 'none') {
        return res.status(403).json({ status: 'error', error: 'Нет доступа' });
    }

    // Получение родителей (GET)
    if (req.method === 'GET') {
        try {
            await ensureBotStatusColumns(sql);

            if (auth.role === 'teacher') {
                const parents = await sql`
                    SELECT id, parent_full_name, child_full_name, school_class, student_status
                    FROM parents
                    WHERE school_class = ${auth.teacherClass}
                    ORDER BY child_full_name, parent_full_name
                `;
                return res.status(200).json({ parents });
            }

            const parents = await sql`SELECT * FROM parents ORDER BY school_class, child_full_name, parent_full_name`;
            const isAdmin = auth.role === 'admin';
            const formatted = parents.map(p => {
                if (isAdmin) {
                    return {
                        ...p,
                        telegram_id: String(p.telegram_id),
                        bot_status: p.bot_status || 'unknown',
                        bot_status_updated_at: p.bot_status_updated_at || null
                    };
                }
                const { bot_status, bot_status_updated_at, ...rest } = p;
                return { ...rest, telegram_id: String(p.telegram_id) };
            });
            return res.status(200).json({ parents: formatted });
        } catch (error) {
            console.error('Ошибка загрузки базы родителей:', error);
            return res.status(500).json({ error: 'Ошибка загрузки данных' });
        }
    }

    // Ручное добавление родителя (POST) — только админ и завуч
    if (req.method === 'POST') {
        if (auth.role !== 'admin' && auth.role !== 'deputy') {
            return res.status(403).json({ status: 'error', message: 'Недостаточно прав' });
        }

        const rawTgId = String(req.body?.telegram_id || '').trim();
        const parentName = String(req.body?.parent_full_name || '').trim().slice(0, 200);
        const childName = String(req.body?.child_full_name || '').trim().slice(0, 200);
        const schoolClass = String(req.body?.school_class || '').trim().toUpperCase();
        const email = String(req.body?.email || '').trim().slice(0, 200);
        const phone = String(req.body?.phone || '').trim().slice(0, 50);
        const address = String(req.body?.address || '').trim().slice(0, 300);

        if (!/^\d{5,15}$/.test(rawTgId)) {
            return res.status(400).json({ status: 'error', message: 'Некорректный Telegram ID' });
        }
        if (!parentName || !childName || !VALID_CLASSES.has(schoolClass)) {
            return res.status(400).json({ status: 'error', message: 'Заполните ФИО родителя, ФИО ребенка и корректный класс' });
        }

        try {
            await ensureBotStatusColumns(sql);
            await sql`
                INSERT INTO parents (telegram_id, parent_full_name, child_full_name, school_class, email, phone, address, student_status, bot_status, bot_status_updated_at)
                VALUES (${rawTgId}, ${parentName}, ${childName}, ${schoolClass}, ${email}, ${phone}, ${address}, 'present', 'not_started', NOW())
            `;
            return res.status(200).json({ status: 'success' });
        } catch (error) {
            console.error('Ошибка добавления родителя:', error);
            return res.status(500).json({ status: 'error', message: 'Ошибка сохранения в БД' });
        }
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
}
