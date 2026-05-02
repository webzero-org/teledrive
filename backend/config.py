from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    # Telegram
    api_id: int = 0
    api_hash: str = ""
    session_string: Optional[str] = None   # user session string (preferred)
    bot_token: Optional[str] = None         # alt: bot token

    # MongoDB
    mongo_uri: str = "mongodb://localhost:27017"
    mongo_db: str = "teledrive"

    # App
    secret_key: str = "change-me-in-production"
    cors_origins: str = "http://localhost:5173"

    class Config:
        env_file = ".env"

settings = Settings()
