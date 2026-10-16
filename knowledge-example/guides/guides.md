---
type: Overview
title: Guides and Operations
description: Operating procedures, troubleshooting guides and cross-cutting explanations for the data platform.
tags: [guides, operations, overview]
created_at: 2026-10-01T09:10:00+13:00
updated_at: 2026-10-13T11:30:00+13:00
---
# Guides and Operations

Guides explain how the platform behaves as a whole rather than describing a single resource. They are written for the on-call data engineer, a new analyst, or anyone who needs to understand why a number on a dashboard looks the way it does.

## Understand the platform

- [Platform Landscape](./platform-landscape.md "introduces") shows every major system and the direction data moves between them.
- [Order Revenue Lineage](./order-revenue-lineage.md "introduces") traces a single order from the customer portal through the lake and warehouse to the sales dashboard.

## Operate the platform

- [Nightly Warehouse Refresh](./nightly-warehouse-refresh.md "introduces") is the runbook for the overnight load: its timeline, checkpoints and the morning sign-off.
- [Troubleshoot Failed Pipeline Runs](./troubleshoot-failed-pipeline-runs.md "introduces") walks from an alert to the failing activity and the safe way to rerun it.
- [Onboarding a Data Source](./onboarding-a-data-source.md "introduces") lists the steps, reviews and artefacts needed before a new source joins the nightly load.

The procedures assume access granted through the platform's normal role assignments; they never require sharing credentials, and secrets are always read from [kv-dataplatform-prd](../infrastructure/cloud/kv-dataplatform-prd.md "references").

Tags: guides, operations, overview.
