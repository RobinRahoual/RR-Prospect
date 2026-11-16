from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://rr:rr@db:5432/rrprospect"
    app_token: str = ""  # vide = pas d'auth (dev uniquement)
    cors_origins: str = ""

    gemini_api_key: str = ""
    gemini_model: str = "gemini-pro-latest"
    gemini_fallback_model: str = "gemini-flash-latest"
    gemini_grounding: bool = False

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
