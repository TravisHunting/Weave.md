---
type: Overview
title: Projects
description: Change programmes that are reshaping the data platform, with their status and the systems they affect.
tags: [projects, roadmap, overview]
created_at: 2026-10-01T12:00:00+13:00
updated_at: 2026-10-13T11:30:00+13:00
---
# Projects

Projects describe planned or in-flight change. Each project article separates what runs today from the target state, so readers can tell which statements describe production. When a project finishes, the articles for the systems it changed are updated and the project article records the outcome.

## Portfolio

| Project | Status | Lead team |
| --- | --- | --- |
| [Warehouse Modernisation](./warehouse-modernisation.md "contains") | In delivery | Data Engineering |
| [Customer 360](./customer-360.md "contains") | Discovery | Analytics and Reporting |
| [Partner Data Sharing](./partner-data-sharing.md "contains") | Live, phase 2 planned | Data Engineering |

```mermaid
quadrantChart
    title Portfolio by value and effort
    x-axis Low effort --> High effort
    y-axis Low value --> High value
    quadrant-1 Major bets
    quadrant-2 Quick wins
    quadrant-3 Fill-ins
    quadrant-4 Reconsider
    Warehouse Modernisation: [0.82, 0.78]
    Customer 360: [0.6, 0.86]
    Partner Data Sharing phase 2: [0.3, 0.55]
```

## How projects are run

Each project has a business sponsor, a lead team and a short decision log kept in its article. Changes to production follow the same release process as day-to-day work; a project never gets a separate path to production. Architecture decisions that affect the whole platform are reviewed by both [Data Engineering](../teams/data-engineering.md) and [Analytics and Reporting](../teams/analytics-and-reporting.md).

Tags: projects, roadmap, overview.
