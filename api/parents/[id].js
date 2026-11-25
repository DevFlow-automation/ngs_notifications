import { neon } from '@neondatabase/serverless';
import { authenticateRequest, VALID_CLASSES } from '../../lib/auth.js';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
    const auth = authenticateRequest(req);
    if (!auth.authenticated) {
        return res.status(401).json({ status: 'error', message: 'Требуется авторизация через Telegram' });
    }
    if (auth.role !== 'admin' && auth.role !== 'deputy') {
        return res.status(403).json({ status: 'error', message: 'Недостаточно прав' });
    }

    const parentId = parseInt(req.query.id, 10);
    if (!Number.isInteger(parentId) || parentId <= 0) {
        return res.status(400).json({ status: 'error', message: 'ID не указан' });
    }

    // Редактирование (PUT)
    if (req.method === 'PUT') {
        const parentName = String(req.body?.parent_full_name || '').trim().slice(0, 200);
        const childName = String(req.body?.child_full_name || '').trim().slice(0, 200);
        const schoolClass = String(req.body?.school_class || '').trim().toUpperCase();
        const email = String(req.body?.email || '').trim().slice(0, 200);
        const phone = String(req.body?.phone || '').trim().slice(0, 50);
        const address = String(req.body?.address || '').trim().slice(0, 300);

        if (!parentName || !childName || !VALID_CLASSES.has(schoolClass)) {
            return res.status(400).json({ status: 'error', message: 'Заполните корректные данные профиля' });
        }

        try {
            await sql`
                UPDATE parents
                SET parent_full_name = ${parentName},
                    child_full_name = ${childName},
                    school_class = ${schoolClass},
                    email = ${email},
                    phone = ${phone},
                    address = ${address}
                WHERE id = ${parentId}
            `;
            return res.status(200).json({ status: 'success' });
        } catch (error) {
            console.error('Ошибка редактирования родителя:', error);
            return res.status(500).json({ status: 'error', message: 'Ошибка обновления данных' });
        }
    }

    // Удаление (DELETE)
    if (req.method === 'DELETE') {
        try {
            await sql`DELETE FROM parents WHERE id = ${parentId}`;
            return res.status(200).json({ status: 'success' });
        } catch (error) {
            console.error('Ошибка удаления родителя:', error);
            return res.status(500).json({ status: 'error', message: 'Ошибка удаления профиля' });
        }
    }

    return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
}
