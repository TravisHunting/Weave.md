---
type: Trigger
title: tr-nightly-0200
description: Daily schedule trigger that starts the master nightly pipeline at 02:00 local time.
tags: [trigger, schedule, ADF]
created_at: 2026-10-06T13:30:00+13:00
updated_at: 2026-10-13T11:30:00+13:00
---
# tr-nightly-0200

`tr-nightly-0200` is the only schedule trigger in the production factory. It starts the [Master Nightly Pipeline](./pl-master-nightly.md "triggers") every day at 02:00 in the local time zone, with `batch_date` set to the previous calendar day.

## Why 02:00

The start time is a compromise between several overnight constraints:

```mermaid
timeline
    title Overnight constraints (local time)
    23.30 : Billing finishes its end-of-day invoice run
    00.00 : Replica catch-up window, up to 30 minutes
    01.00 : Host patching window for vm-shir-01, first Sunday only
    02.00 : tr-nightly-0200 fires
    06.00 : Partners begin polling for files
    07.00 : Reporting must be ready for the business day
```

Starting earlier risks reading the [Ledgerline Replica](../infrastructure/data-stores/ledgerline-replica.md "waits-for") before the end-of-day invoice run has replicated; starting later leaves too little slack before partners and report users need the data.

## Daylight saving

The trigger is defined in the local time zone rather than UTC, so it follows daylight saving changes. On the night clocks go forward, 02:00 does not exist and the run starts at 03:00; on the night they go back, the factory fires once, at the first 02:00.

## Changing the schedule

The trigger is deployed with the factory from Git, so a schedule change goes through the same review as a pipeline change. Pause it — rather than deleting it — during planned maintenance on [sqldb-warehouse-prd](../infrastructure/data-stores/sqldb-warehouse-prd.md), and note the pause in the run log so the morning sign-off in [Nightly Warehouse Refresh](../guides/nightly-warehouse-refresh.md) is not mistaken for a failure.

Tags: trigger, schedule, ADF.
