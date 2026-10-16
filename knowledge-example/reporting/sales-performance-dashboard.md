---
type: Report
title: Sales Performance Dashboard
description: Daily Power BI dashboard showing revenue, orders and channel performance against last year and target.
tags: [dashboard, Power BI, sales]
created_at: 2026-10-05T14:00:00+13:00
updated_at: 2026-10-13T11:30:00+13:00
---
# Sales Performance Dashboard

The Sales Performance Dashboard is the trading view that sales and marketing leads open each morning. It shows yesterday's and month-to-date revenue, order counts and channel mix, compared with last year and with target. Every visual reads from the [Sales Semantic Model](./sales-semantic-model.md "reads-from"); the dashboard contains no measures of its own.

## Pages

```mermaid
flowchart TB
    home["Overview<br/>headline tiles and trend"] --> chan["Channels<br/>Portal · Mobile · Assisted"]
    home --> cat["Categories<br/>revenue and units by category"]
    home --> reg["Regions<br/>row-level security applies"]
    cat --> drill["Order drill-through<br/>order lines for a selection"]
    reg --> drill
```

## Typical channel mix

The channel page leads with a share-of-revenue chart. The figures below are illustrative of a normal month:

```mermaid
pie showData
    title Net revenue by channel (illustrative month)
    "Portal" : 58
    "Mobile" : 31
    "Assisted" : 11
```

## Reading it correctly

- **Revenue means invoiced revenue.** A spike in orders shows in `Pending Value` first and moves into `Net Revenue` as orders ship; [Order Revenue Lineage](../guides/order-revenue-lineage.md "explained-by") explains why.
- **Recent days can change.** Credits re-state the trailing 35 days, so last week's figure may fall slightly.
- **Targets are monthly.** Daily targets are a straight-line split of the monthly target and ignore weekday seasonality.

## Freshness

A banner at the top shows the model's last refresh time. If it is earlier than today's 05:00, the nightly run has not finished; the [Nightly Warehouse Refresh](../guides/nightly-warehouse-refresh.md) runbook describes what the on-call engineer is checking.

The dashboard is published in the `Sales [Prod]` app and owned by [Analytics and Reporting](../teams/analytics-and-reporting.md "owned-by").

Tags: dashboard, Power BI, sales.
