# Example: Kotlin (Gradle) project

Uses the shared JVM adapter (see `docs/adapters.md` for why Java and Kotlin
share one adapter). Try:

```
dev_detect(".")        # should report jvm as primary, with *.kt evidence
dev_project_info(".")  # shows java + kotlin runtimes and gradle build tool
dev_check(".")          # runs `./gradlew test` if a wrapper is present
```
