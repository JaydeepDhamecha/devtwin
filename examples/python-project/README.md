# Example: Python project

Depends on `psycopg2-binary`, which is DevTwin's signal (alongside any
`DATABASE_URL`/`POSTGRES_*` env vars or compose services) for detecting
that this project likely needs a running PostgreSQL instance.

Try:

```
dev_detect(".")
dev_health(".")
dev_services(".")
```

If PostgreSQL isn't running locally, `dev_health` should surface a
`service.not_running` issue for `postgresql`.
