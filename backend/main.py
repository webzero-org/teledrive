from dotenv import load_dotenv
load_dotenv()

from config import settings
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import db
from telegram_client import get_client, disconnect_client
from routes import files, channels, shares, sync


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    await get_client()   # warm up Telegram session on startup
    yield
    await disconnect_client()
    await db.disconnect()


app = FastAPI(title="TeleDrive API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(files.router)
app.include_router(channels.router)
app.include_router(shares.router)
app.include_router(sync.router)


@app.get("/health")
async def health():
    return {"ok": True}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
