import { neon } from '@neondatabase/serverless';
import { authenticateRequest } from '../lib/auth.js';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    const auth = authenticateRequest(req);
    if (!auth.authenticated) return res.status(401).json({ error: 'Требуется авторизация через Telegram' });
    if (auth.role === 'none') return res.status(403).json({ error: 'Нет доступа' });

    try {
        if (auth.role === 'admin' || auth.role === 'deputy') {
            const result = await sql`SELECT DISTINCT school_class FROM parents`;
            const classes = result.map(row => row.school_class).filter(Boolean);
            classes.sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
            return res.status(200).json({ classes });
        }

        if (auth.role === 'teacher' && auth.teacherClass) {
            return res.status(200).json({ classes: [auth.teacherClass] });
        }

        return res.status(200).json({ classes: [] });
    } catch (error) {
        console.error('Ошибка загрузки классов:', error);
        return res.status(500).json({ error: 'Ошибка загрузки данных' });
    }
}
