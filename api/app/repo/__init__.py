"""Data access layer: abstract Repository + Postgres and in-memory implementations."""

from app.config import Settings
from app.repo.base import ConflictError, Repository
from app.repo.memory import MemoryRepository


def build_repository(settings: Settings) -> Repository:
    if settings.repository == "memory":
        return MemoryRepository()
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL is required when REPOSITORY=postgres")
    from app.repo.postgres import PostgresRepository

    return PostgresRepository(
        settings.database_url,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
        enforce_rls=settings.db_enforce_rls,
    )


__all__ = ["ConflictError", "MemoryRepository", "Repository", "build_repository"]
