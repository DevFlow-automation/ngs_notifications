import { neon } from '@neondatabase/serverless';
import exceljs from 'exceljs';
import { authenticateRequest, sanitizeExcelCell } from '../lib/auth.js';
import { BOT_STATUS_LABELS, ensureBotStatusColumns } from '../lib/botStatus.js';

const sql = neon(process.env.DATABASE_URL);

const STATUS_TRANSLATIONS = {
    "present": "Присутствует",
    "sick": "Болеет",
    "excused": "Уважительная причина",
    "unexcused": "Неуважительная причина",
    "late": "Опоздал"
};

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

    const auth = authenticateRequest(req, { allowExportToken: true });
    if (!auth.authenticated) {
        return res.status(401).send("<h1>Требуется авторизация</h1>");
    }

    const isAdmin = auth.role === 'admin';

    // Проверка прав: экспорт доступен только админам и завучам
    if (!isAdmin && auth.role !== 'deputy') {
        return res.status(403).send("<h1>Нет доступа</h1>");
    }

    try {
        await ensureBotStatusColumns(sql);

        // 1. Запрашиваем данные из базы Neon
        const parents = await sql`SELECT * FROM parents ORDER BY school_class, parent_full_name`;

        // Получаем историю сразу с подсчетом подтверждений (ack_count)
        const history = await sql`
            SELECT
                m.id,
                m.recipient_id,
                m.message_text,
                m.timestamp,
                (SELECT COUNT(id) FROM acknowledgments a WHERE a.history_id = m.id) as ack_count
            FROM history m
            ORDER BY m.timestamp DESC
        `;

        // 2. Создаем новую Excel книгу
        const workbook = new exceljs.Workbook();

        // --- ЛИСТ 1: База родителей ---
        const wsParents = workbook.addWorksheet('База родителей');

        // Настраиваем колонки и их ширину (колонка статуса бота — только для админа)
        const parentColumns = [
            { header: 'ID', key: 'id', width: 10 },
            { header: 'Telegram ID', key: 'telegram_id', width: 15 },
            { header: 'ФИО Родителя', key: 'parent_full_name', width: 30 },
            { header: 'ФИО Ребенка', key: 'child_full_name', width: 30 },
            { header: 'Класс', key: 'school_class', width: 10 },
            { header: 'Email', key: 'email', width: 25 },
            { header: 'Телефон', key: 'phone', width: 20 },
            { header: 'Адрес', key: 'address', width: 35 },
            { header: 'Статус', key: 'status', width: 20 }
        ];
        if (isAdmin) {
            parentColumns.push({ header: 'Статус бота', key: 'bot_status', width: 22 });
        }
        wsParents.columns = parentColumns;

        // Стилизуем заголовок (жирный текст)
        wsParents.getRow(1).font = { bold: true };

        // Заполняем данные (с защитой от формульных инъекций в Excel)
        parents.forEach(p => {
            const row = {
                id: p.id,
                telegram_id: String(p.telegram_id), // Преобразуем BigInt в строку
                parent_full_name: sanitizeExcelCell(p.parent_full_name),
                child_full_name: sanitizeExcelCell(p.child_full_name),
                school_class: sanitizeExcelCell(p.school_class),
                email: sanitizeExcelCell(p.email),
                phone: sanitizeExcelCell(p.phone),
                address: sanitizeExcelCell(p.address),
                status: STATUS_TRANSLATIONS[p.student_status] || "Неизвестно"
            };
            if (isAdmin) {
                row.bot_status = BOT_STATUS_LABELS[p.bot_status || 'unknown'] || 'Не проверен';
            }
            wsParents.addRow(row);
        });


        // --- ЛИСТ 2: История рассылок ---
        const wsHistory = workbook.addWorksheet('История рассылок');

        wsHistory.columns = [
            { header: 'ID Отправки', key: 'id', width: 15 },
            { header: 'Дата и время', key: 'time', width: 20 },
            { header: 'Получатель(и)', key: 'target', width: 30 },
            { header: 'Текст сообщения', key: 'text', width: 60 },
            { header: 'Кол-во подтверждений', key: 'ack_count', width: 25 }
        ];

        wsHistory.getRow(1).font = { bold: true };

        // Создаем карту родителей для быстрого поиска по ID (чтобы не делать запросы в БД в цикле)
        const parentMap = new Map();
        parents.forEach(p => parentMap.set(String(p.telegram_id), p));

        history.forEach(msg => {
            // Форматируем время
            const d = new Date(msg.timestamp);
            const timeStr = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;

            // Форматируем получателя
            let targetDisplay = msg.recipient_id;
            if (targetDisplay === 'all') targetDisplay = "Всем родителям";
            else if (targetDisplay === 'sick') targetDisplay = "Всем болеющим";
            else if (targetDisplay === 'excused') targetDisplay = "Отсутствующим (уваж.)";
            else if (targetDisplay === 'unexcused') targetDisplay = "Отсутствующим (неуваж.)";
            else if (targetDisplay === 'late') targetDisplay = "Опоздавшим";
            else if (!isNaN(targetDisplay)) {
                // Если отправлено конкретному родителю (по ID)
                const p = parentMap.get(String(targetDisplay));
                if (p) {
                    targetDisplay = `${p.parent_full_name} (Класс ${p.school_class})`;
                } else {
                    targetDisplay = `ID: ${targetDisplay}`;
                }
            } else {
                targetDisplay = `Класс ${targetDisplay}`;
            }

            // Добавляем строку
            wsHistory.addRow({
                id: msg.id,
                time: timeStr,
                target: sanitizeExcelCell(targetDisplay),
                text: sanitizeExcelCell(msg.message_text),
                ack_count: Number(msg.ack_count)
            });
        });

        // 3. Отдаем файл на скачивание
        // Устанавливаем заголовки, чтобы браузер понял, что это Excel-файл и начал скачивание
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="school_database_and_history.xlsx"');

        // Конвертируем книгу в буфер и отправляем как ответ
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        return res.status(200).send(buffer);

    } catch (error) {
        console.error("Ошибка экспорта Excel:", error);
        return res.status(500).send("<h1>Ошибка сервера при генерации Excel</h1>");
    }
}
