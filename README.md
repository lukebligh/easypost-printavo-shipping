# EasyPost → Printavo Shipping Fee Automation

Webhook service that auto-writes shipping costs to Printavo when an order is completed.

## What it does

1. Receives a Printavo webhook on status change
2. Ignores if status is not one of the COMPLETED triggers
3. Ignores if delivery method is not UPS Ground / UPS 2 Day / UPS Overnight
4. Finds EasyPost shipments by matching the invoice's shipping address (zip + street)
5. Sums `selected_rate.rate` across all matched shipments, adds 10% markup
6. Writes a **Shipping** fee to the Printavo invoice
7. Changes order status to **ORDER SHIPPED & INVOICED** (triggers client invoice email)
8. Sends Slack DM to Luke on any error (status is never changed if any step fails)

## Deploy on Railway

### 1. Create a new Railway service

In your existing Railway project, click **New → Empty service**. Name it `easypost-printavo-shipping`.

Push this folder as the service's source (or point Railway at the GitHub repo folder).

### 2. Set environment variables

In Railway → service → Variables, add:

| Variable | Value |
|---|---|
| `PRINTAVO_EMAIL` | `sales@estmerch.com` |
| `PRINTAVO_TOKEN` | *(from Printavo Settings → API)* |
| `EASYPOST_API_KEY` | `EZAKd497933544664d368c38e09d712bf8cfD` |
| `SLACK_WEBHOOK_URL` | *(copy from the existing Printavo MCP service's variables)* |

Railway auto-sets `PORT` — the service reads it automatically.

### 3. Get the public URL

Railway generates a URL like `https://easypost-printavo-shipping-production.up.railway.app`.

Copy it — you'll need it for the Printavo webhook.

### 4. Configure Printavo webhook

In Printavo → Settings → Integrations → Webhooks:

- Click **Add Webhook**
- URL: `https://<your-railway-url>/webhook`
- Event: **Invoice Updated** (or "All events" if per-event isn't available)
- Save

### 5. Verify the first run

After the next order hits a COMPLETED status:

1. Check Railway logs — you'll see the full webhook payload printed
2. Confirm the status and delivery method are extracted correctly
3. If the `feeCreate` mutation fails, the error message will tell us the exact field names to fix

## Troubleshooting

**No shipments found:** EasyPost `reference` field is null (Printavo doesn't populate it), so we match by shipping address. If the zip or street doesn't match, you'll get a Slack alert. Check the Railway logs to see what address was on the invoice vs what was on the EasyPost shipments.

**feeCreate error:** The Printavo GraphQL fee mutation input field names couldn't be confirmed without a test run. If you see an error like `Field 'cost' doesn't exist`, check the error message — it will name the correct field — and I can patch `server.js` immediately.

**ORDER SHIPPED & INVOICED not found:** If this status doesn't exist in your Printavo account yet, you'll get a Slack alert. Create the status in Printavo → Settings → Statuses, then it will work automatically on the next order.

**DTF status name:** Printavo shows this as `DTF - COMPLETE` (not `DTF - COMPLETED`). Both variants are handled.

## Address matching logic

Since Printavo doesn't expose EasyPost shipment IDs in their GraphQL API, we:

1. Fetch all purchased EasyPost shipments from the last 14 days
2. Match by: **zip must match exactly** AND (street prefix matches OR name prefix matches)
3. Collect all matches and sum their rates

This is reliable for a low-volume operation. If you ever have two orders shipping to the same address in the same 14-day window, you'll need to manually verify — a Slack alert will include the matched shipment IDs.
