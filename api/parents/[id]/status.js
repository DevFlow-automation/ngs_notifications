import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
    if (req.method !== 'PUT') return res.status(405).json({ status: "error", message: "Method Not Allowed" });

    const parentId = parseInt(req.query.id, 10);
    const { status, parent_ids } = req.body;

    const targetIds = Array.isArray(parent_ids) && parent_ids.length > 0
        ? parent_ids.map(id => parseInt(id, 10)).filter(Number.isInteger)
        : (Number.isInteger(parentId) ? [parentId] : []);

    if (targetIds.length === 0) {
        return res.status(400).json({ status: "error", message: "ID не указан" });
    }

    try {
        await sql`UPDATE parents SET student_status = ${status} WHERE id = ANY(${targetIds}::int[])`;
        return res.status(200).json({ status: "success", student_status: status, updated_ids: targetIds });
    } catch (error) {
        return res.status(500).json({ status: "error", message: error.message });
    }
}
