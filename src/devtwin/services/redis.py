"""Redis service detector."""

from __future__ import annotations

from devtwin.services.base import ServiceDetector


class RedisDetector(ServiceDetector):
    name = "redis"
    default_port = 6379
    env_var_patterns = (r"^REDIS", r"^CACHE_URL$")
    dependency_names = ("redis", "ioredis", "django-redis")
    compose_image_hints = ("redis",)
    readme_keywords = ("redis",)
