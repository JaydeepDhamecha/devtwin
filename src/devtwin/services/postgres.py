"""PostgreSQL service detector."""

from __future__ import annotations

from devtwin.services.base import ServiceDetector


class PostgresDetector(ServiceDetector):
    name = "postgresql"
    default_port = 5432
    env_var_patterns = (r"^POSTGRES", r"^PG(HOST|PORT|USER|PASSWORD|DATABASE)$", r"^DATABASE_URL$")
    dependency_names = ("psycopg2", "psycopg2-binary", "psycopg", "pg", "asyncpg", "postgres")
    compose_image_hints = ("postgres", "postgresql", "timescale")
    readme_keywords = ("postgres", "postgresql")
