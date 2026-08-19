# Example: Java (Maven) project

```
dev_detect(".")
dev_drift(".")   # compares maven.compiler.target (21) against your installed java, if a JAVA_VERSION check applies
```

Note: DevTwin reads the Maven compiler target as evidence but its primary
drift source for JVM projects is the Gradle wrapper's pinned version when
present; Maven projects without a wrapper are inspected for `mvn`
availability instead.
