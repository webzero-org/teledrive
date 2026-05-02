from motor.motor_asyncio import AsyncIOMotorClient
from config import settings

client: AsyncIOMotorClient = None
db = None

async def connect():
    global client, db
    client = AsyncIOMotorClient(settings.mongo_uri)
    db = client[settings.mongo_db]
    await _ensure_indexes()

async def disconnect():
    if client:
        client.close()

async def _ensure_indexes():
    # files collection
    await db.files.create_index("message_id", unique=True)
    await db.files.create_index("channel_id")
    await db.files.create_index("path")
    await db.files.create_index("type")
    await db.files.create_index([("channel_id", 1), ("path", 1)])

    # thumbnails collection
    await db.thumbnails.create_index("message_id", unique=True)
    await db.thumbnails.create_index("original_message_id")

    # shares collection
    await db.shares.create_index("token", unique=True)
    await db.shares.create_index("channel_id")

def get_db():
    return db
