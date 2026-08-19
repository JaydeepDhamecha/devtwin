# Example: Node.js project

Pins `pnpm@9.1.0` via `packageManager`, requires Node `>=20`, and depends on
`redis`. Try:

```
dev_detect(".")
dev_drift(".")       # compares your installed node/pnpm against the pins above
dev_services(".")    # should flag redis as required
```
