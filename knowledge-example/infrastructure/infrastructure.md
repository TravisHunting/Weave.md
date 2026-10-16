---
type: Overview
title: Infrastructure
description: Overview of the cloud estate, data stores, compute, source applications and suppliers behind the data platform.
tags: [infrastructure, Azure, overview]
created_at: 2026-10-01T11:00:00+13:00
updated_at: 2026-10-13T11:30:00+13:00
---
# Infrastructure

The data platform runs almost entirely in one Azure production subscription. The exceptions are the two SaaS source applications and the billing replica, which sits in a supplier's hosted network and is reached through a self-hosted integration runtime.

```mermaid
flowchart TB
    subgraph azure["Microsoft Azure · production subscription"]
        subgraph rgdp["rg-dataplatform-prd"]
            adf["adf-dataplatform-prd"]
            sql[("sqldb-warehouse-prd")]
            lake[("stdatalakeprd")]
            kv["kv-dataplatform-prd"]
            shir["vm-shir-01"]
        end
        subgraph rgapps["rg-apps-prd"]
            aks["aks-apps-prd"]
            func["func-order-events"]
        end
    end
    subgraph saas["SaaS"]
        crm["Relay CRM"]
        billing["Ledgerline Billing"]
    end
    subgraph hosted["Kestrel hosted network"]
        replica[("Ledgerline Replica")]
    end
    aks -- events --> func --> lake
    crm --> adf
    billing -. replicates .-> replica
    replica --> shir --> adf
    adf --> lake & sql
    adf -. secrets .-> kv
```

## Cloud

- [Microsoft Azure](./cloud/microsoft-azure.md "contains") — the subscription, landing zone and shared services.
- [rg-dataplatform-prd](./cloud/rg-dataplatform-prd.md "contains") — the resource group that holds every data platform resource.
- [kv-dataplatform-prd](./cloud/kv-dataplatform-prd.md "contains") — the key vault for connection secrets.

## Data stores

- [sqldb-warehouse-prd](./data-stores/sqldb-warehouse-prd.md "contains") — the Azure SQL warehouse database.
- [stdatalakeprd](./data-stores/stdatalakeprd.md "contains") — the ADLS Gen2 data lake.
- [Ledgerline Replica](./data-stores/ledgerline-replica.md "contains") — the vendor-hosted read replica of billing.

## Compute

- [vm-shir-01](./compute/vm-shir-01.md "contains") — the self-hosted integration runtime host.
- [aks-apps-prd](./compute/aks-apps-prd.md "contains") — the Kubernetes cluster that runs the customer portal.
- [func-order-events](./compute/func-order-events.md "contains") — the function app that lands portal order events.

## Applications

- [Customer Portal](./applications/customer-portal.md "contains") — the storefront and self-service site.
- [Relay CRM](./applications/relay-crm.md "contains") — the SaaS customer relationship system.
- [Ledgerline Billing](./applications/ledgerline-billing.md "contains") — the SaaS billing and subscription system.

## Suppliers

- [Brightwater Analytics](./vendors/brightwater-analytics.md "contains") — the consultancy that designed the warehouse.
- [Kestrel Managed Services](./vendors/kestrel-managed-services.md "contains") — the managed service provider for hosting and patching.

Tags: infrastructure, Azure, overview.
