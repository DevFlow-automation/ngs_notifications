import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncAttrs
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy import String, BigInteger, Text, DateTime, func, Integer
from dotenv import load_dotenv

load_dotenv()

db_url = os.getenv("DATABASE_URL", "")
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql+asyncpg://", 1)
elif db_url.startswith("postgresql://"):
    db_url = db_url.replace("postgresql://", "postgresql+asyncpg://", 1)

db_url = db_url.replace("sslmode=require", "ssl=require")

engine = create_async_engine(db_url, echo=False)
async_session = async_sessionmaker(engine, expire_on_commit=False)

class Base(AsyncAttrs, DeclarativeBase):
    pass

class Parent(Base):
    __tablename__ = 'parents'
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger)
    parent_full_name: Mapped[str] = mapped_column(String(100))
    child_full_name: Mapped[str] = mapped_column(String(100))
    school_class: Mapped[str] = mapped_column(String(20))
    email: Mapped[str] = mapped_column(String(100))
    phone: Mapped[str] = mapped_column(String(20))
    address: Mapped[str] = mapped_column(String(255))

class MessageHistory(Base):
    __tablename__ = 'messages'
    
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    recipient_id: Mapped[str] = mapped_column(String(50))
    message_text: Mapped[str] = mapped_column(Text)
    timestamp: Mapped[DateTime] = mapped_column(DateTime, default=func.now())

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
