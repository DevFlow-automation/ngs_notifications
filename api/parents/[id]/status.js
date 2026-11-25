import { neon } from '@neondatabase/serverless';
import { authenticateRequest, VALID_STUDENT_STATUSES } from '../../../lib/auth.js';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
    if (req.method !== 'PUT') return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });

    const auth = authenticateRequest(req);
    if (!auth.authenticated) {
        return res.status(401).json({ status: 'error', message: 'Требуется авторизация через Telegram' });
    }
    if (auth.role === 'none') {
        return res.status(403).json({ status: 'error', message: 'Нет доступа' });
    }

    const parentId = parseInt(req.query.id, 10);
    const { status, parent_ids } = req.body || {};

    if (!VALID_STUDENT_STATUSES.has(String(status || ''))) {
        return res.status(400).json({ status: 'error', message: 'Некорректный статус ученика' });
    }

    const targetIds = Array.isArray(parent_ids) && parent_ids.length > 0
        ? parent_ids.map(id => parseInt(id, 10)).filter(id => Number.isInteger(id) && id > 0)
        : (Number.isInteger(parentId) && parentId > 0 ? [parentId] : []);

    if (targetIds.length === 0) {
        return res.status(400).json({ status: 'error', message: 'ID не указан' });
    }

    try {
        if (auth.role === 'teacher') {
            await sql`
                UPDATE parents
                SET student_status = ${status}
                WHERE id = ANY(${targetIds}::int[]) AND school_class = ${auth.teacherClass}
            `;
        } else {
            await sql`
                UPDATE parents
                SET student_status = ${status}
                WHERE id = ANY(${targetIds}::int[])
            `;
        }
        return res.status(200).json({ status: 'success', student_status: status, updated_ids: targetIds });
    } catch (error) {
        console.error('Ошибка обновления статуса ученика:', error);
        return res.status(500).json({ status: 'error', message: 'Ошибка обновления статуса' });
    }
}
