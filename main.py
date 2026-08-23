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
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton, WebAppInfo, InlineKeyboardMarkup, InlineKeyboardButton
from sqlalchemy import select, desc, func
from dotenv import load_dotenv

from database import init_db, async_session, Parent, MessageHistory, Acknowledgment

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
WEBAPP_URL = os.getenv("WEBAPP_URL")
WEBHOOK_PATH = "/webhook"

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()
ADMIN_ID = 8771384583

class Registration(StatesGroup):
    waiting_for_parent_name = State()
    waiting_for_child_name = State()
    waiting_for_school_class = State()
    waiting_for_email = State()
    waiting_for_phone = State()
    waiting_for_address = State()

class AddChild(StatesGroup):
    waiting_for_child_name = State()
    waiting_for_school_class = State()

@dp.message(CommandStart())
async def cmd_start(message: types.Message, state: FSMContext):
    if message.from_user.id == ADMIN_ID:
        kb = ReplyKeyboardMarkup(
            keyboard=[
                [KeyboardButton(text="Панель рассылки", web_app=WebAppInfo(url=WEBAPP_URL))]
            ],
            resize_keyboard=True
        )
        await message.answer("Добро пожаловать, администратор! Нажмите кнопку ниже, чтобы открыть панель рассылки.", reply_markup=kb)
        return

    async with async_session() as session:
        result = await session.execute(
            select(Parent).where(Parent.telegram_id == message.from_user.id).limit(1)
        )
        parent = result.scalar_one_or_none()
        
        if parent:
            await message.answer(
                "Вы уже зарегистрированы в системе оповещений.\n\n"
                "Если вы хотите добавить данные еще одного ребенка, отправьте команду /add_child"
            )
            return

    welcome_text = (
        "Добро пожаловать в официальный бот оповещений New Generation School.\n\n"
        "Бот предназначен для получения важных уведомлений и оперативной связи администрации с родителями. "
        "Для подключения к системе рассылки необходимо пройти регистрацию.\n\n"
        "В процессе регистрации вам потребуется указать:\n"
        "* Ваши ФИО и ФИО ребенка\n"
        "* Класс обучения\n"
        "* Адрес электронной почты\n"
        "* Контактный номер телефона\n"
        "* Адрес проживания\n\n"
        "Пожалуйста, введите ваши ФИО (например, Иванов Иван Иванович), чтобы начать процесс регистрации."
    )
    await message.answer(welcome_text)
    await state.set_state(Registration.waiting_for_parent_name)

@dp.message(Registration.waiting_for_parent_name, F.text)
async def process_parent_name(message: types.Message, state: FSMContext):
    await state.update_data(parent_full_name=message.text)
    await message.answer("Теперь введите ФИО вашего ребенка:")
    await state.set_state(Registration.waiting_for_child_name)

@dp.message(Registration.waiting_for_child_name, F.text)
async def process_child_name(message: types.Message, state: FSMContext):
    await state.update_data(child_full_name=message.text)
    await message.answer("Введите класс, в котором учится ребенок (число от 1 до 11 и буква, например, 5А):")
    await state.set_state(Registration.waiting_for_school_class)

@dp.message(Registration.waiting_for_school_class, F.text)
async def process_school_class(message: types.Message, state: FSMContext):
    school_class = message.text.replace(" ", "").upper()
    
    if not re.fullmatch(r"^(1[0-1]|[1-9])[А-Я]$", school_class):
        await message.answer("Неверный формат. Введите существующий класс (например, 5А или 11Б):")
        return

    await state.update_data(school_class=school_class)
    await message.answer("Напишите ваш адрес электронной почты:")
    await state.set_state(Registration.waiting_for_email)

@dp.message(Registration.waiting_for_email, F.text)
async def process_email(message: types.Message, state: FSMContext):
    if not re.match(r"^[\w\.-]+@[\w\.-]+\.\w+$", message.text):
        await message.answer("Неверный формат почты. Пожалуйста, введите корректный адрес:")
        return
        
    await state.update_data(email=message.text)
    await message.answer("Введите ваш номер телефона в формате +998 хх - ххх - хх - хх.\nВажно указать рабочий реальный номер, благодаря этому мы сможем оперативно связываться с вами.")
    await state.set_state(Registration.waiting_for_phone)

@dp.message(Registration.waiting_for_phone, F.text)
async def process_phone(message: types.Message, state: FSMContext):
    phone_clean = re.sub(r"[\s-]", "", message.text)
    
    if not re.fullmatch(r"^\+998\d{9}$", phone_clean):
        await message.answer("Неверный формат номера. Введите номер в формате +998 хх - ххх - хх - хх:")
        return
        
    await state.update_data(phone=message.text)
    await message.answer("Укажите адрес, где вы сейчас проживаете:")
    await state.set_state(Registration.waiting_for_address)

@dp.message(Registration.waiting_for_address, F.text)
async def process_address(message: types.Message, state: FSMContext):
    data = await state.get_data()
    
    async with async_session() as session:
        new_parent = Parent(
            telegram_id=message.from_user.id,
            parent_full_name=data['parent_full_name'],
            child_full_name=data['child_full_name'],
            school_class=data['school_class'],
            email=data['email'],
            phone=data['phone'],
            address=message.text
        )
        session.add(new_parent)
        await session.commit()

    await state.clear()
    await message.answer("Регистрация успешно завершена! Теперь вы будете получать оповещения.")

@dp.message(Command("add_child"))
async def cmd_add_child(message: types.Message, state: FSMContext):
    async with async_session() as session:
        result = await session.execute(
            select(Parent).where(Parent.telegram_id == message.from_user.id).limit(1)
        )
        parent = result.scalar_one_or_none()
        
        if not parent:
            await message.answer("Сначала пройдите основную регистрацию через команду /start.")
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
    await message.answer("Введите класс, в котором учится этот ребенок (число от 1 до 11 и буква, например, 5А):")
    await state.set_state(AddChild.waiting_for_school_class)

@dp.message(AddChild.waiting_for_school_class, F.text)
async def process_additional_school_class(message: types.Message, state: FSMContext):
    school_class = message.text.replace(" ", "").upper()
    
    if not re.fullmatch(r"^(1[0-1]|[1-9])[А-Я]$", school_class):
        await message.answer("Неверный формат. Введите существующий класс (например, 5А или 11Б):")
        return

    data = await state.get_data()
    
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

@dp.callback_query(F.data.startswith("ack_"))
async def process_acknowledgment(callback: types.CallbackQuery):
    history_id = int(callback.data.split("_")[1])
    
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

@app.post(WEBHOOK_PATH)
async def bot_webhook(request: Request):
    update_data = await request.json()
    telegram_update = types.Update(**update_data)
    await dp.feed_update(bot=bot, update=telegram_update)
    return {"status": "ok"}

@app.get("/api/classes")
async def get_classes():
    async with async_session() as db_session:
        result = await db_session.execute(select(Parent.school_class).distinct())
        classes = [row[0] for row in result.all()]
    return {"classes": classes}

@app.get("/api/students/{class_name}")
async def get_students(class_name: str):
    async with async_session() as db_session:
        result = await db_session.execute(
            select(Parent.telegram_id, Parent.child_full_name)
            .where(Parent.school_class == class_name)
        )
        students = [{"telegram_id": str(row[0]), "child_full_name": row[1]} for row in result.all()]
    return {"students": students}

@app.get("/api/history")
async def get_history():
    async with async_session() as db_session:
        result = await db_session.execute(
            select(MessageHistory).order_by(desc(MessageHistory.timestamp)).limit(50)
        )
        history = result.scalars().all()
        
        data = []
        for msg in history:
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

@app.post("/api/send")
async def send_message(data: MessageData):
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
            
        new_msg = MessageHistory(recipient_id=data.target_value, message_text=data.text)
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

@app.get("/api/export")
async def export_excel():
    async with async_session() as db_session:
        result_parents = await db_session.execute(select(Parent).order_by(Parent.school_class, Parent.parent_full_name))
        parents = result_parents.scalars().all()
        
        result_history = await db_session.execute(select(MessageHistory).order_by(desc(MessageHistory.timestamp)))
        history = result_history.scalars().all()

    wb = openpyxl.Workbook()
    
    # Лист 1: База родителей
    ws1 = wb.active
    ws1.title = "База родителей"
    
    headers_parents = ["ID", "Telegram ID", "ФИО Родителя", "ФИО Ребенка", "Класс", "Email", "Телефон", "Адрес"]
    ws1.append(headers_parents)

    for p in parents:
        ws1.append([p.id, p.telegram_id, p.parent_full_name, p.child_full_name, p.school_class, p.email, p.phone, p.address])
        
    # Форматирование ширины столбцов
    for col in ['C', 'D', 'E', 'F', 'G', 'H']:
        ws1.column_dimensions[col].width = 25

    # Лист 2: История рассылок
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
            
    # Форматирование ширины столбцов
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

@app.get("/", response_class=HTMLResponse)
async def get_html():
    file_path = os.path.join(os.path.dirname(__file__), "index.html")
    with open(file_path, "r", encoding="utf-8") as f:
        return f.read()
