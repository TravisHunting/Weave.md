---
type: Application
title: Customer Portal
description: The customer-facing storefront and self-service site where orders and subscriptions are placed and managed.
tags: [application, portal, e-commerce]
created_at: 2026-10-03T13:30:00+13:00
updated_at: 2026-10-13T11:30:00+13:00
---
# Customer Portal

The Customer Portal is the website and mobile web experience where customers browse products, place orders, start subscriptions and manage their accounts. It is built and run by the digital product team on [aks-apps-prd](../compute/aks-apps-prd.md "hosted-in"). For the data platform it is a source of order events, not a database to extract.

## What it depends on

```mermaid
flowchart LR
    cust(("Customer")) --> portal["Customer Portal"]
    portal -- "account lookup" --> crm["Relay CRM"]
    portal -- "prices, invoices,<br/>subscriptions" --> billing["Ledgerline Billing"]
    portal -- "OrderPlaced events" --> eh["evh-orders-prd"]
    eh --> func["func-order-events"]
    func --> lake[("stdatalakeprd")]
```

The portal reads customer accounts from [Relay CRM](./relay-crm.md "uses") and creates orders, invoices and subscriptions through the API of [Ledgerline Billing](./ledgerline-billing.md "uses"). It owns no customer master data of its own beyond sessions and baskets.

## Checkout sequence

```mermaid
sequenceDiagram
    actor C as Customer
    participant P as Portal
    participant B as Ledgerline Billing
    participant E as Event Hub
    C->>P: Place order
    P->>B: Create order and payment intent
    B-->>P: Order number, payment confirmed
    P-->>C: Confirmation page
    P->>E: OrderPlaced event
    Note over B: Invoice raised when the order ships
```

The order number returned by billing is carried in the `OrderPlaced` event; it is the join key that lets [dw.fact_orders](../../data-warehouse/fact-orders.md "feeds") combine portal events with invoice lines. Events are delivered to the lake by [func-order-events](../compute/func-order-events.md).

## Channels

The portal serves two sales channels: `Portal` for desktop and `Mobile` for the mobile web layout. Orders taken by the call centre bypass the portal and are recorded as `Assisted` in the warehouse.

Tags: application, portal, e-commerce.
