import asyncio
import os
import re
import io
import openpyxl
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import CommandStart, Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import WebAppInfo, InlineKeyboardMarkup, InlineKeyboardButton
from sqlalchemy import select, desc, func
from dotenv import load_dotenv

from database import init_db, async_session, Parent, MessageHistory, Acknowledgment

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
WEBAPP_URL = os.getenv("WEBAPP_URL")
WEBHOOK_PATH = "/webhook"

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# ================= РОЛИ И ДОСТУПЫ =================
ADMIN_IDS = [8771384583, 229049117] 
DEPUTY_IDS = [
    # Сюда вписывайте ID замдиректоров через запятую
    387863654,21900086,87180537,32542185,1759984801,11763622,1176641277, 117636223,219000864
]


TEACHERS = {
    # Сюда вписывайте ID учителей и их классы (ID: "КЛАСС")
    # 333333333: "5А",
    # 444444444: "11Б"
    593614259: "1А",
    7475228092: "1Б",
    165555820: "1В",
    6759744115: "1Г",
    677271764: "2А",
    2067119625: "2Б",
    192592122: "2В",
    261773072: "2Г",
    843534212: "3А",
    83655322: "3Б",
    1579165503: "3В",
    1849602045: "3Г",
    389444120: "4А",
    8300203162: "4Б",
    132622662: "4В",
    267481288: "5А",
    815313499: "5Б",
    937544028: "5В",
    127589326: "6А",
    905178719: "6Б",
    8885418064: "7А",
    8099039998: "7Б",
    144330475: "7В",
    241743825: "8А",
    42760022: "8Б",
    1329417314: "9А",
    124341010: "10А",
    539135124: "11А",
}

# ==================================================

class AddChild(StatesGroup):
    waiting_for_child_name = State()
    waiting_for_school_class = State()

@dp.message(CommandStart())
async def cmd_start(message: types.Message, state: FSMContext):
    user_id = message.from_user.id
    is_staff = user_id in ADMIN_IDS or user_id in DEPUTY_IDS or user_id in TEACHERS
    
    if is_staff:
        kb_staff = InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="Панель управления", web_app=WebAppInfo(url=WEBAPP_URL))]
            ]
        )
        if user_id in ADMIN_IDS:
            role_name = "администратор"
        elif user_id in DEPUTY_IDS:
            role_name = "замдиректора"
        else:
            role_name = f"классный руководитель ({TEACHERS[user_id]})"
            
        await message.answer(f"Добро пожаловать, {role_name}! Нажмите кнопку ниже, чтобы открыть панель управления.", reply_markup=kb_staff)

    async with async_session() as session:
        result = await session.execute(
            select(Parent).where(Parent.telegram_id == user_id).limit(1)
        )
        parent = result.scalar_one_or_none()
        
    if not parent:
        kb_reg = InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="📝 Пройти регистрацию", web_app=WebAppInfo(url=f"{WEBAPP_URL}/register"))]
            ]
        )
        welcome_text = (
            "Добро пожаловать в официальный бот оповещений New Generation School.\n\n"
            "Для подключения к системе рассылки необходимо заполнить анкету. "
            "Пожалуйста, нажмите на кнопку ниже, чтобы пройти быструю регистрацию."
        )
        await message.answer(welcome_text, reply_markup=kb_reg)
    elif not is_staff:
        await message.answer(
            "Вы уже зарегистрированы в системе оповещений.\n\n"
            "Если вы хотите добавить данные еще одного ребенка, отправьте команду /add_child"
        )

@dp.message(Command("add_child"))
async def cmd_add_child(message: types.Message, state: FSMContext):
    async with async_session() as session:
        result = await session.execute(
            select(Parent).where(Parent.telegram_id == message.from_user.id).limit(1)
        )
        parent = result.scalar_one_or_none()
        
        if not parent:
            await message.answer("Сначала пройдите основную регистрацию через кнопку в /start.")
            return
            
        await state.update_data(
            parent_full_name=parent.parent_full_name,
            email=parent.email,
            phone=parent.phone,
            address=parent.address
        )
        
    await message.answer("Введите ФИО еще одного вашего ребенка:")
    await state.set_state(AddChild.waiting_for_child_name)

@dp.message(AddChild.waiting_for_child_name, F.text)
async def process_additional_child_name(message: types.Message, state: FSMContext):
    await state.update_data(child_full_name=message.text)
    await message.answer("Введите класс, в котором учится этот ребенок (например, 5А):")
    await state.set_state(AddChild.waiting_for_school_class)

@dp.message(AddChild.waiting_for_school_class, F.text)
async def process_additional_school_class(message: types.Message, state: FSMContext):
    school_class = message.text.replace(" ", "").upper()
    
    if not re.fullmatch(r"^(1[0-1]|[1-9])[А-ЯA-Z]$", school_class):
        await message.answer("Неверный формат. Введите существующий класс (например, 5А):")
        return

    data = await state.get_data()
    
    try:
        async with async_session() as session:
            new_parent = Parent(
                telegram_id=message.from_user.id,
                parent_full_name=data['parent_full_name'],
                child_full_name=data['child_full_name'],
                school_class=school_class,
                email=data['email'],
                phone=data['phone'],
                address=data['address']
            )
            session.add(new_parent)
            await session.commit()
        await state.clear()
        await message.answer("Данные второго ребенка успешно добавлены! Теперь вы будете получать оповещения и для этого класса.")
    except Exception as e:
        await message.answer("Произошла ошибка при сохранении данных. Пожалуйста, попробуйте позже.")

@dp.callback_query(F.data.startswith("ack_"))
async def process_acknowledgment(callback: types.CallbackQuery):
    history_id = int(callback.data.split("_")[1])
    try:
        async with async_session() as session:
            result = await session.execute(
                select(Acknowledgment).where(
                    Acknowledgment.history_id == history_id,
                    Acknowledgment.telegram_id == callback.from_user.id
                )
            )
            if not result.scalar_one_or_none():
                new_ack = Acknowledgment(history_id=history_id, telegram_id=callback.from_user.id)
                session.add(new_ack)
                await session.commit()
                
        await callback.answer("Вы подтвердили ознакомление!", show_alert=False)
        await callback.message.edit_reply_markup(reply_markup=None)
    except Exception:
        await callback.answer("Произошла ошибка. Попробуйте еще раз.", show_alert=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    webhook_url = f"{WEBAPP_URL}{WEBHOOK_PATH}"
    await bot.set_webhook(url=webhook_url, allowed_updates=dp.resolve_used_update_types())
    yield
    await bot.session.close()

app = FastAPI(lifespan=lifespan)

class MessageData(BaseModel):
    target_type: str
    target_value: str
    text: str
    user_id: int

class ParentUpdate(BaseModel):
    parent_full_name: str
    child_full_name: str
    school_class: str
    email: str
    phone: str
    address: str

class ParentCreate(ParentUpdate):
    telegram_id: int

class RegistrationData(BaseModel):
    user_id: int
    parent_full_name: str
    child_full_name: str
    school_class: str
    phone: str
    email: str
    address: str

@app.post(WEBHOOK_PATH)
async def bot_webhook(request: Request):
    update_data = await request.json()
    telegram_update = types.Update(**update_data)
    await dp.feed_update(bot=bot, update=telegram_update)
    return {"status": "ok"}

@app.get("/api/me")
async def get_me(user_id: int = 0):
    if user_id in ADMIN_IDS:
        return {"role": "admin", "class": None}
    elif user_id in DEPUTY_IDS:
        return {"role": "deputy", "class": None}
    elif user_id in TEACHERS:
        return {"role": "teacher", "class": TEACHERS[user_id]}
    return {"role": "none", "class": None}

@app.get("/api/classes")
async def get_classes(user_id: int = 0):
    if user_id in ADMIN_IDS or user_id in DEPUTY_IDS:
        async with async_session() as db_session:
            result = await db_session.execute(select(Parent.school_class).distinct())
            classes = [row[0] for row in result.all()]
        return {"classes": classes}
    elif user_id in TEACHERS:
        return {"classes": [TEACHERS[user_id]]}
    return {"classes": []}

@app.get("/api/students/{class_name}")
async def get_students(class_name: str, user_id: int = 0):
    if user_id in TEACHERS and TEACHERS[user_id] != class_name:
        return {"students": []}
        
    async with async_session() as db_session:
        result = await db_session.execute(
            select(Parent.telegram_id, Parent.child_full_name, Parent.parent_full_name)
            .where(Parent.school_class == class_name)
        )
        students = [{"telegram_id": str(row[0]), "child_full_name": row[1], "parent_full_name": row[2]} for row in result.all()]
    return {"students": students}

@app.get("/api/history")
async def get_history(user_id: int = 0):
    if user_id not in ADMIN_IDS and user_id not in DEPUTY_IDS and user_id not in TEACHERS:
        return {"history": []}
        
    async with async_session() as db_session:
        query = select(MessageHistory).order_by(desc(MessageHistory.timestamp)).limit(50)
        result = await db_session.execute(query)
        history = result.scalars().all()
        
        data = []
        for msg in history:
            if user_id in TEACHERS:
                if msg.sender_id != user_id and msg.recipient_id != TEACHERS[user_id]:
                    if msg.recipient_id.isdigit():
                        p_res = await db_session.execute(select(Parent.school_class).where(Parent.telegram_id == int(msg.recipient_id)).limit(1))
                        p_class = p_res.scalar_one_or_none()
                        if p_class != TEACHERS[user_id]:
                            continue
                    else:
                        continue
                        
            ack_result = await db_session.execute(
                select(func.count(Acknowledgment.id)).where(Acknowledgment.history_id == msg.id)
            )
            ack_count = ack_result.scalar() or 0
            
            time_str = msg.timestamp.strftime("%d.%m.%Y %H:%M") if msg.timestamp else ""
            
            target_display = msg.recipient_id
            if target_display == 'all':
                target_display = "Всем родителям"
            elif target_display.isdigit():
                parent_result = await db_session.execute(
                    select(Parent).where(Parent.telegram_id == int(msg.recipient_id)).limit(1)
                )
                parent = parent_result.scalar_one_or_none()
                if parent:
                    target_display = f"{parent.parent_full_name} (реб. {parent.child_full_name}, {parent.school_class})"
                else:
                    target_display = f"Удаленный профиль (ID: {msg.recipient_id})"
            else:
                target_display = f"Класс {msg.recipient_id}"
                
            data.append({
                "id": msg.id,
                "target": target_display,
                "text": msg.message_text,
                "time": time_str,
                "ack_count": ack_count
            })
            
    return {"history": data}

@app.get("/api/parents")
async def get_all_parents(user_id: int = 0):
    if user_id not in ADMIN_IDS:
        return {"parents": []}
        
    async with async_session() as db_session:
        result = await db_session.execute(select(Parent).order_by(Parent.school_class, Parent.parent_full_name))
        parents = result.scalars().all()
        data = [{
            "id": p.id,
            "telegram_id": p.telegram_id,
            "parent_full_name": p.parent_full_name,
            "child_full_name": p.child_full_name,
            "school_class": p.school_class,
            "email": p.email,
            "phone": p.phone,
            "address": p.address
        } for p in parents]
        return {"parents": data}

@app.post("/api/parents")
async def create_parent_manual(data: ParentCreate, user_id: int = 0):
    if user_id not in ADMIN_IDS:
        return {"status": "error", "message": "Нет прав"}
        
    try:
        async with async_session() as db_session:
            new_parent = Parent(
                telegram_id=data.telegram_id,
                parent_full_name=data.parent_full_name,
                child_full_name=data.child_full_name,
                school_class=data.school_class,
                email=data.email,
                phone=data.phone,
                address=data.address
            )
            db_session.add(new_parent)
            await db_session.commit()
            return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.put("/api/parents/{parent_id}")
async def update_parent(parent_id: int, data: ParentUpdate, user_id: int = 0):
    if user_id not in ADMIN_IDS:
        return {"status": "error", "message": "Нет прав"}
        
    try:
        async with async_session() as db_session:
            result = await db_session.execute(select(Parent).where(Parent.id == parent_id))
            parent = result.scalar_one_or_none()
            if parent:
                parent.parent_full_name = data.parent_full_name
                parent.child_full_name = data.child_full_name
                parent.school_class = data.school_class
                parent.email = data.email
                parent.phone = data.phone
                parent.address = data.address
                await db_session.commit()
                return {"status": "success"}
            return {"status": "error", "message": "Родитель не найден"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.delete("/api/parents/{parent_id}")
async def delete_parent(parent_id: int, user_id: int = 0):
    if user_id not in ADMIN_IDS:
        return {"status": "error", "message": "Нет прав"}
        
    try:
        async with async_session() as db_session:
            result = await db_session.execute(select(Parent).where(Parent.id == parent_id))
            parent = result.scalar_one_or_none()
            if parent:
                await db_session.delete(parent)
                await db_session.commit()
                return {"status": "success"}
            return {"status": "error", "message": "Родитель не найден"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/register")
async def api_register_parent(data: RegistrationData):
    try:
        async with async_session() as db_session:
            result = await db_session.execute(select(Parent).where(Parent.telegram_id == data.user_id).limit(1))
            if result.scalar_one_or_none():
                return {"status": "error", "message": "Вы уже зарегистрированы!"}
                
            new_parent = Parent(
                telegram_id=data.user_id,
                parent_full_name=data.parent_full_name,
                child_full_name=data.child_full_name,
                school_class=data.school_class,
                email=data.email,
                phone=data.phone,
                address=data.address
            )
            db_session.add(new_parent)
            await db_session.commit()
            
            try:
                await bot.send_message(data.user_id, "Регистрация успешно завершена! Теперь вы будете получать оповещения.")
            except Exception:
                pass 
            return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": "Ошибка БД. Попробуйте еще раз."}

@app.post("/api/send")
async def send_message(data: MessageData):
    user_id = data.user_id
    if user_id not in ADMIN_IDS and user_id not in DEPUTY_IDS and user_id not in TEACHERS:
        return {"status": "error", "message": "Нет прав"}

    if user_id in TEACHERS:
        allowed_class = TEACHERS[user_id]
        if data.target_type == 'all':
            return {"status": "error", "message": "Нет прав для массовой рассылки"}
        elif data.target_type == 'class' and data.target_value != allowed_class:
            return {"status": "error", "message": "Можно писать только своему классу"}
        elif data.target_type == 'student':
            async with async_session() as db_session:
                res = await db_session.execute(select(Parent.school_class).where(Parent.telegram_id == int(data.target_value)).limit(1))
                p_class = res.scalar_one_or_none()
                if p_class != allowed_class:
                    return {"status": "error", "message": "Ученик не из вашего класса"}

    try:
        async with async_session() as db_session:
            if data.target_type == 'all':
                result = await db_session.execute(select(Parent.telegram_id).distinct())
            elif data.target_type == 'class':
                result = await db_session.execute(
                    select(Parent.telegram_id).where(Parent.school_class == data.target_value).distinct()
                )
            elif data.target_type == 'student':
                result = await db_session.execute(
                    select(Parent.telegram_id).where(Parent.telegram_id == int(data.target_value)).distinct()
                )
            else:
                return {"status": "error"}
                
            parent_ids = [row[0] for row in result.all()]
            if not parent_ids:
                return {"status": "error", "message": "Нет получателей"}
                
            new_msg = MessageHistory(sender_id=user_id, recipient_id=data.target_value, message_text=data.text)
            db_session.add(new_msg)
            await db_session.flush()
            
            markup = InlineKeyboardMarkup(
                inline_keyboard=[[InlineKeyboardButton(text="Ознакомлен ✅", callback_data=f"ack_{new_msg.id}")]]
            )
            
            success_count = 0
            for pid in parent_ids:
                try:
                    await bot.send_message(chat_id=pid, text=data.text, reply_markup=markup)
                    success_count += 1
                    await asyncio.sleep(0.05)
                except Exception as e:
                    print(f"Ошибка отправки пользователю {pid}: {e}")
                    
            await db_session.commit()
            
        return {"status": "success", "count": success_count}
    except Exception as e:
        return {"status": "error", "message": "Ошибка БД при рассылке."}

@app.get("/api/export")
async def export_excel(user_id: int = 0):
    if user_id not in ADMIN_IDS and user_id not in DEPUTY_IDS:
        return HTMLResponse("<h1>Нет доступа</h1>", status_code=403)

    async with async_session() as db_session:
        result_parents = await db_session.execute(select(Parent).order_by(Parent.school_class, Parent.parent_full_name))
        parents = result_parents.scalars().all()
        
        result_history = await db_session.execute(select(MessageHistory).order_by(desc(MessageHistory.timestamp)))
        history = result_history.scalars().all()

    wb = openpyxl.Workbook()
    ws1 = wb.active
    ws1.title = "База родителей"
    
    headers_parents = ["ID", "Telegram ID", "ФИО Родителя", "ФИО Ребенка", "Класс", "Email", "Телефон", "Адрес"]
    ws1.append(headers_parents)

    for p in parents:
        ws1.append([p.id, p.telegram_id, p.parent_full_name, p.child_full_name, p.school_class, p.email, p.phone, p.address])
        
    for col in ['C', 'D', 'E', 'F', 'G', 'H']:
        ws1.column_dimensions[col].width = 25

    ws2 = wb.create_sheet(title="История рассылок")
    headers_history = ["ID Отправки", "Дата и время", "Получатель(и)", "Текст сообщения", "Кол-во подтверждений"]
    ws2.append(headers_history)
    
    async with async_session() as session:
        for msg in history:
            ack_result = await session.execute(
                select(func.count(Acknowledgment.id)).where(Acknowledgment.history_id == msg.id)
            )
            ack_count = ack_result.scalar() or 0
            
            time_str = msg.timestamp.strftime("%d.%m.%Y %H:%M") if msg.timestamp else ""
            
            target_display = msg.recipient_id
            if target_display == 'all':
                target_display = "Всем родителям"
            elif target_display.isdigit():
                parent_result = await session.execute(
                    select(Parent).where(Parent.telegram_id == int(msg.recipient_id)).limit(1)
                )
                parent = parent_result.scalar_one_or_none()
                if parent:
                    target_display = f"{parent.parent_full_name} (Класс {parent.school_class})"
                else:
                    target_display = f"ID: {msg.recipient_id}"
            else:
                target_display = f"Класс {msg.recipient_id}"
                
            ws2.append([msg.id, time_str, target_display, msg.message_text, ack_count])
            
    ws2.column_dimensions['B'].width = 20
    ws2.column_dimensions['C'].width = 30
    ws2.column_dimensions['D'].width = 50
    ws2.column_dimensions['E'].width = 25

    stream = io.BytesIO()
    wb.save(stream)
    stream.seek(0)

    headers = {
        'Content-Disposition': 'attachment; filename="school_database_and_history.xlsx"'
    }
    return StreamingResponse(
        stream, 
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 
        headers=headers
    )

@app.get("/register", response_class=HTMLResponse)
async def get_register_html():
    file_path = os.path.join(os.path.dirname(__file__), "register.html")
    with open(file_path, "r", encoding="utf-8") as f:
        return f.read()

@app.get("/", response_class=HTMLResponse)
async def get_html():
    file_path = os.path.join(os.path.dirname(__file__), "index.html")
    with open(file_path, "r", encoding="utf-8") as f:
        return f.read()
