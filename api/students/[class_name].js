import { neon } from '@neondatabase/serverless';
import { authenticateRequest } from '../../lib/auth.js';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    const auth = authenticateRequest(req);
    if (!auth.authenticated) return res.status(401).json({ error: 'Требуется авторизация через Telegram' });
    if (auth.role === 'none') return res.status(403).json({ error: 'Нет доступа' });

    // Поддержка обоих вариантов названия файла в Vercel: [id].js или [class_name].js
    const className = String(req.query.id || req.query.class_name || '').trim();
    if (!className) return res.status(400).json({ error: 'Класс не указан' });

    if (auth.role === 'teacher' && className !== auth.teacherClass) {
        return res.status(403).json({ error: 'Доступ разрешен только к своему классу' });
    }

    try {
        const result = await sql`
            SELECT telegram_id, child_full_name, parent_full_name
            FROM parents
            WHERE school_class = ${className}
            ORDER BY child_full_name ASC
        `;
        const students = result.map(s => ({ ...s, telegram_id: String(s.telegram_id) }));
        return res.status(200).json({ students });
    } catch (error) {
        console.error('Ошибка загрузки учеников класса:', error);
        return res.status(500).json({ error: 'Ошибка загрузки данных' });
    }
}
