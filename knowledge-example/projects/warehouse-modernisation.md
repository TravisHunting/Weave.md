---
type: Project
title: Warehouse Modernisation
description: Programme to move transformation into lakehouse delta tables, adopt billing's change feed and make the platform resilient.
tags: [project, lakehouse, modernisation]
created_at: 2026-10-07T09:00:00+13:00
updated_at: 2026-10-13T11:30:00+13:00
---
# Warehouse Modernisation

Warehouse Modernisation moves the platform from a nightly, database-centred load to a lakehouse pattern in which modelled data lives as delta tables in the lake and the SQL database serves only reporting. It is led by [Data Engineering](../teams/data-engineering.md "led-by"), with [Brightwater Analytics](../infrastructure/vendors/brightwater-analytics.md "advised-by") reviewing the design. Nothing described under "target state" runs in production yet.

## Why

- **Missed subscription changes.** [dw.fact_subscription_events](../data-warehouse/fact-subscription-events.md "changes") cannot see changes that reverse within a day, because [Extract Billing](../pipelines/pl-extract-billing.md "changes") reads only the latest state from the replica.
- **Single runtime node.** [vm-shir-01](../infrastructure/compute/vm-shir-01.md "changes") is a single point of failure for billing data.
- **Cost.** Scaling [sqldb-warehouse-prd](../infrastructure/data-stores/sqldb-warehouse-prd.md "changes") to 40 vCores every night is the platform's largest cost.

## Target state

```mermaid
flowchart LR
    subgraph today["Today"]
        a1[("raw files")] --> a2["stg → dw → mart<br/>in Azure SQL"]
    end
    subgraph target["Target"]
        b1[("raw files")] --> b2["bronze delta"]
        cf["billing change feed"] --> b2
        b2 --> b3["silver delta<br/>conformed"]
        b3 --> b4["gold delta<br/>dims and facts"]
        b4 --> b5[("Azure SQL<br/>serving marts only")]
    end
    today -. "migrate table by table" .-> target
```

Modelled tables move to the `curated` container of [stdatalakeprd](../infrastructure/data-stores/stdatalakeprd.md "uses"), and [Load Warehouse](../pipelines/pl-load-warehouse.md "replaces") is split into a lake transformation step and a small serving load.

## Plan

```mermaid
gantt
    title Warehouse Modernisation plan
    dateFormat YYYY-MM-DD
    section Foundations
    Delta storage and access      :done, f1, 2026-07-01, 45d
    Second runtime node           :active, f2, 2026-09-01, 30d
    section Billing
    Change feed agreement         :done, b1, 2026-08-01, 30d
    Change feed ingestion         :active, b2, 2026-09-15, 60d
    section Migration
    Dimensions to gold            :m1, after b2, 45d
    Facts to gold                 :m2, after m1, 60d
    Serving marts cut-over        :milestone, m3, after m2, 0d
```

## Decisions

| Date | Decision |
| --- | --- |
| 2026-07 | Keep Azure SQL for serving so Power BI connections do not change |
| 2026-08 | Ledgerline to provide a change feed in place of the replica's subscription table |
| 2026-09 | Dimension history migrates as-is; no restatement of past versions |

## Risks

Dimension history in [dw.dim_customer](../data-warehouse/dim-customer.md) cannot be rebuilt from raw files alone, so it is migrated by copying rather than reprocessing. Report owners in [Analytics and Reporting](../teams/analytics-and-reporting.md) will validate each migrated table against the [Sales Semantic Model](../reporting/sales-semantic-model.md) before cut-over.

Tags: project, lakehouse, modernisation.
