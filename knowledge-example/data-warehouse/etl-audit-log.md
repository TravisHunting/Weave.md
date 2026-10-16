---
type: Table
title: ETL Audit Log
description: Append-only log of every pipeline run and step, with status, row counts and error details.
tags: [audit, ETL, monitoring]
created_at: 2026-10-05T10:20:00+13:00
updated_at: 2026-10-13T11:30:00+13:00
---
# ETL Audit Log

The audit log, `etl.run_log` and `etl.step_log`, is the platform's memory of what ran. Every pipeline writes a row when a step starts and updates it when the step finishes, so the log shows progress during a run and the full history afterwards. It is the first place to look when [troubleshooting a failed run](../guides/troubleshoot-failed-pipeline-runs.md "used-by").

## Structure

```mermaid
erDiagram
    RUN_LOG ||--|{ STEP_LOG : "contains"
    RUN_LOG {
        bigint run_id PK
        varchar pipeline_name
        varchar trigger_name
        datetime2 started_at
        datetime2 finished_at
        varchar status
        bigint resume_of_run_id
    }
    STEP_LOG {
        bigint step_id PK
        bigint run_id FK
        varchar step_name
        datetime2 started_at
        datetime2 finished_at
        varchar status
        int rows_read
        int rows_written
        int rows_rejected
        nvarchar error_message
    }
```

## Step status

```mermaid
stateDiagram-v2
    [*] --> Running: step started
    Running --> Succeeded: rows written
    Running --> Failed: error raised
    Running --> Skipped: already succeeded in resumed run
    Failed --> [*]
    Succeeded --> [*]
    Skipped --> [*]
```

A step left in `Running` after its run has ended means the factory stopped without reaching the step's failure path, usually because the self-hosted runtime was restarted mid-copy.

## Writers and readers

All pipelines under the [Master Nightly Pipeline](../pipelines/pl-master-nightly.md "written-by") log here, including [Extract CRM](../pipelines/pl-extract-crm.md "written-by"), [Extract Billing](../pipelines/pl-extract-billing.md "written-by") and [Load Warehouse](../pipelines/pl-load-warehouse.md "written-by"). The master pipeline reads it to decide which steps to skip when resuming a run. The morning sign-off in [Nightly Warehouse Refresh](../guides/nightly-warehouse-refresh.md) queries it directly.

Rows are never deleted. Runs older than two years are moved to `etl.run_log_archive` each January.

Tags: audit, ETL, monitoring.
