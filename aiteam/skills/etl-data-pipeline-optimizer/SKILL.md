---
name: etl-data-pipeline-optimizer
description: Best practices for data pipelines, batch/stream processing, and Airflow/dbt.
---

# Skill: ETL & Data Pipeline Optimizer

This skill provides domain expertise in building resilient, high-throughput data pipelines.

## Principles
1. **Idempotency:** All data transformations must be idempotent. Re-running a pipeline should yield the exact same state without duplicating data.
2. **Separation of Compute and Storage:** Favor architectures that decouple compute from storage (e.g., Snowflake, BigQuery) for analytical workloads.
3. **Data Quality Gates:** Implement assertions and data quality checks (e.g., Great Expectations) before loading data into production analytical tables.
4. **Streaming vs Batch:** Use stream processing (Kafka/Kinesis) only when sub-minute latency is a strict business requirement; otherwise, default to micro-batching for lower cost and complexity.
