# Example: Generic Docker/compose project

No language manifest at all -- purely `Dockerfile` + `docker-compose.yml`.
The `GenericAdapter` still detects this as a project and `dev_services`
should report `db` (Postgres) and `cache` (Redis) via the dedicated
detectors, both driven by the `image:` lines in `docker-compose.yml`.

```
dev_detect(".")     # ecosystems: ["generic"]
dev_services(".")   # postgresql + redis, required=true, running=<docker state>
```
