import { Bot } from 'grammy';
import { neon } from '@neondatabase/serverless';
import { ADMIN_IDS, DEPUTY_IDS, TEACHERS, verifyWebhookSecret } from '../lib/auth.js';
import { updateBotStatusSingle } from '../lib/botStatus.js';

const sql = neon(process.env.DATABASE_URL);
const bot = new Bot(process.env.BOT_TOKEN);

// Глобальный перехватчик ошибок бота (защита от падений)
bot.catch((err) => {
    console.error(`Ошибка обработки у пользователя ${err.ctx.from?.id}:`, err.error);
});

bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    const isStaff = ADMIN_IDS.includes(userId) || DEPUTY_IDS.includes(userId) || !!TEACHERS[userId];
    const WEBAPP_URL = process.env.WEBAPP_URL;

    if (isStaff) {
        let roleName = "классный руководитель";
        if (ADMIN_IDS.includes(userId)) roleName = "администратор";
        else if (DEPUTY_IDS.includes(userId)) roleName = "замдиректора";

        await ctx.reply(`Добро пожаловать, ${roleName}! Нажмите кнопку ниже, чтобы открыть панель управления.`, {
            reply_markup: {
                inline_keyboard: [[{ text: "Панель управления", web_app: { url: WEBAPP_URL } }]]
            }
        });
        
        return; // КРИТИЧЕСКИ ВАЖНО: Останавливаем код, чтобы не дублировать сообщения
    }

    try {
        const parents = await sql`SELECT * FROM parents WHERE telegram_id = ${userId} LIMIT 1`;
        
        if (parents.length === 0) {
            await ctx.reply(
                "Добро пожаловать в официальный бот оповещений New Generation School.\n\nДля подключения к системе рассылки необходимо заполнить анкету.", 
                {
                    reply_markup: {
                        inline_keyboard: [[{ text: "📝 Пройти регистрацию", web_app: { url: `${WEBAPP_URL}/register.html` } }]]
                    }
                }
            );
        } else {
            await updateBotStatusSingle(sql, userId, 'active').catch(() => {});
            await ctx.reply("Вы уже зарегистрированы в системе оповещений.\n\nЕсли вы хотите добавить данные еще одного ребенка, отправьте команду /add_child");
        }
    } catch (error) {
        console.error("Ошибка БД при /start:", error);
        await ctx.reply("Система временно недоступна. Пожалуйста, попробуйте позже.");
    }
});

// Отслеживаем блокировку / разблокировку бота родителем в реальном времени
bot.on('my_chat_member', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const tgUserId = ctx.from?.id || ctx.chat?.id;
    const newStatus = ctx.myChatMember?.new_chat_member?.status;
    if (!tgUserId || !newStatus) return;

    try {
        if (newStatus === 'kicked') {
            await updateBotStatusSingle(sql, tgUserId, 'blocked');
        } else if (newStatus === 'member') {
            await updateBotStatusSingle(sql, tgUserId, 'active');
        }
    } catch (error) {
        console.error('Ошибка обновления bot_status в my_chat_member:', error);
    }
});

bot.callbackQuery(/ack_(\d+)/, async (ctx) => {
    const historyId = parseInt(ctx.match[1], 10);
    const userId = ctx.from.id;

    try {
        const existing = await sql`
            SELECT id FROM acknowledgments 
            WHERE history_id = ${historyId} AND telegram_id = ${userId}
        `;

        if (existing.length === 0) {
            // ИСПРАВЛЕНО: добавлено NOW() для колонки timestamp
            await sql`
                INSERT INTO acknowledgments (history_id, telegram_id, timestamp) 
                VALUES (${historyId}, ${userId}, NOW())
            `;
        }
        await updateBotStatusSingle(sql, userId, 'active').catch(() => {});
        await ctx.answerCallbackQuery("Вы подтвердили ознакомление!");
        await ctx.editMessageReplyMarkup(); 
    } catch (error) {
        console.error(error);
        await ctx.answerCallbackQuery({ text: "Произошла ошибка.", show_alert: true });
    }
});

// Пуленепробиваемый обработчик для Vercel Serverless
// ГАРАНТИРУЕТ отправку 200 OK в Telegram, чтобы избежать шторма дублей
// Пуленепробиваемый обработчик для Vercel Serverless
export default async function handler(req, res) {
    if (req.method === 'POST') {
        if (!verifyWebhookSecret(req)) {
            return res.status(403).send('Forbidden');
        }
        try {
            // Явная инициализация бота для бессерверной среды
            await bot.init(); 
            await bot.handleUpdate(req.body);
        } catch (error) {
            console.error("Критическая ошибка вебхука:", error);
        }
    }
    return res.status(200).send('OK');
}
