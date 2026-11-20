import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
    // Получение всех родителей (GET)
    if (req.method === 'GET') {
        const userId = parseInt(req.query.user_id, 10) || 0;
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
}; // Укажите ваших учителей

        try {
            let parents;
            if (TEACHERS[userId]) {
                const sClass = TEACHERS[userId];
                parents = await sql`SELECT * FROM parents WHERE school_class = ${sClass} ORDER BY child_full_name, parent_full_name`;
            } else {
                parents = await sql`SELECT * FROM parents ORDER BY school_class, child_full_name, parent_full_name`;
            }
            // Преобразуем BigInt (telegram_id) в строку, иначе JSON.stringify выдаст ошибку
            const formatted = parents.map(p => ({ ...p, telegram_id: String(p.telegram_id) }));
            return res.status(200).json({ parents: formatted });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    // Ручное добавление родителя (POST)
    if (req.method === 'POST') {
        const { telegram_id, parent_full_name, child_full_name, school_class, email, phone, address } = req.body;
        try {
            await sql`
                INSERT INTO parents (telegram_id, parent_full_name, child_full_name, school_class, email, phone, address, student_status)
                VALUES (${telegram_id}, ${parent_full_name}, ${child_full_name}, ${school_class}, ${email}, ${phone}, ${address}, 'present')
            `;
            return res.status(200).json({ status: "success" });
        } catch (error) {
            return res.status(500).json({ status: "error", message: error.message });
        }
    }

    return res.status(405).json({ error: "Method Not Allowed" });
}
