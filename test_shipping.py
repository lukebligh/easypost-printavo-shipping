#!/usr/bin/env python3
"""
Standalone test script for the EasyPost → Printavo shipping automation.
Run this in Terminal to test a single order end-to-end without deploying anything.

Usage:
    python3 test_shipping.py <order_number>

Example:
    python3 test_shipping.py 6799

What it does:
    1. Fetches the Printavo invoice shipping address
    2. Searches EasyPost for matching purchased shipments (last 14 days)
    3. Sums selected_rate.rate + 10% markup
    4. Writes the Shipping fee to Printavo
    5. Changes order status to ORDER SHIPPED & INVOICED

Use --dry-run to preview without making any changes:
    python3 test_shipping.py 6799 --dry-run
"""

import sys
import re
import json
from datetime import datetime, timezone, timedelta

try:
    import httpx
except ImportError:
    print("httpx not installed. Run:  pip3 install httpx")
    sys.exit(1)

# ── CONFIG ────────────────────────────────────────────────────────────────────

PRINTAVO_EMAIL   = "sales@estmerch.com"
PRINTAVO_TOKEN   = "7XkMlq8ocd5UfxcwX5PBiQ"
EASYPOST_API_KEY = "EZAKd497933544664d368c38e09d712bf8cfD4Mx7b1Rs62WZNk83NoQhQ"

PRINTAVO_API    = "https://www.printavo.com/api/v2"
EASYPOST_API    = "https://api.easypost.com/v2"
SHIPPING_MARKUP = 1.10   # 10%
LOOKBACK_DAYS   = 14
SHIPPED_STATUS  = "ORDER SHIPPED & INVOICED"

# ── HELPERS ───────────────────────────────────────────────────────────────────

def norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def gql(query, variables=None):
    payload = {"query": query}
    if variables:
        payload["variables"] = variables
    r = httpx.post(
        PRINTAVO_API,
        json=payload,
        headers={"Content-Type": "application/json",
                 "email": PRINTAVO_EMAIL, "token": PRINTAVO_TOKEN},
        timeout=20,
    )
    data = r.json()
    if "errors" in data:
        raise RuntimeError(f"Printavo GQL error: {data['errors']}")
    return data.get("data", {})


def easypost_shipments():
    start = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).isoformat()
    all_ships, before_id = [], None
    for _ in range(10):
        params = {"purchased": "true", "page_size": 100, "start_datetime": start}
        if before_id:
            params["before_id"] = before_id
        r = httpx.get(f"{EASYPOST_API}/shipments",
                      auth=(EASYPOST_API_KEY, ""), params=params, timeout=20)
        r.raise_for_status()
        data = r.json()
        batch = data.get("shipments", [])
        all_ships.extend(batch)
        if not data.get("has_more") or not batch:
            break
        before_id = batch[-1]["id"]
    return all_ships


def match_shipments(shipments, addr):
    inv_zip    = norm(addr.get("zipCode") or addr.get("zip") or "")
    inv_street = norm(addr.get("address1") or addr.get("street1") or "")
    inv_name   = norm(addr.get("customerName") or addr.get("name") or "")
    matched = []
    for s in shipments:
        a = s.get("to_address") or {}
        if norm(a.get("zip") or "") != inv_zip:
            continue
        street_ok = len(inv_street) >= 4 and norm(a.get("street1") or "").startswith(inv_street[:8])
        name_ok   = len(inv_name)   >= 3 and inv_name[:5] in norm(a.get("name") or "")
        if street_ok or name_ok:
            matched.append(s)
    return matched


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    visual_id = args[0]
    dry_run   = "--dry-run" in args

    if dry_run:
        print("⚠️  DRY RUN — no changes will be made to Printavo\n")

    print(f"── Order #{visual_id} ──────────────────────────────────")

    # Step 1: get invoice
    print("Step 1: Fetching invoice from Printavo...")
    res = gql("""
        query($q: String) {
            invoices(first: 5, query: $q) {
                nodes {
                    id visualId
                    shippingAddress {
                        customerName address1 address2 city state zipCode country
                    }
                    fees { nodes { id description amount } }
                    status { name }
                }
            }
        }
    """, {"q": visual_id})

    nodes = res.get("invoices", {}).get("nodes", [])
    inv   = next((n for n in nodes if str(n.get("visualId")) == str(visual_id)), None)
    if not inv:
        print(f"ERROR: Order #{visual_id} not found in Printavo.")
        sys.exit(1)

    internal_id = inv["id"]
    print(f"  Internal ID: {internal_id}")
    print(f"  Status: {inv.get('status', {}).get('name', '?')}")

    # Idempotency check — only skip if a non-zero shipping fee already exists
    existing_fees = inv.get("fees", {}).get("nodes", [])
    real_shipping = [f for f in existing_fees
                     if "shipping" in (f.get("description") or "").lower()
                     and float(f.get("amount") or 0) > 0]
    if real_shipping:
        print(f"  ✓ Shipping fee already exists (${real_shipping[0].get('amount')}) — nothing to do.")
        sys.exit(0)
    # Remove any $0 placeholder fees so the real one can be written
    zero_shipping = [f for f in existing_fees
                     if "shipping" in (f.get("description") or "").lower()
                     and float(f.get("amount") or 0) == 0]
    if zero_shipping:
        print(f"  ⚠ Found {len(zero_shipping)} $0 Shipping fee(s) — will overwrite with real amount.")

    addr = inv.get("shippingAddress") or {}
    if not addr or not addr.get("zipCode"):
        print("ERROR: No shipping address / zip on this invoice.")
        sys.exit(1)

    print(f"  Ship to: {addr.get('customerName')} | {addr.get('address1')}, {addr.get('zipCode')}")

    # Step 2: EasyPost
    print(f"\nStep 2: Fetching EasyPost shipments (last {LOOKBACK_DAYS} days)...")
    all_ships = easypost_shipments()
    print(f"  Total purchased shipments: {len(all_ships)}")

    matched = match_shipments(all_ships, addr)
    print(f"  Matched to this address: {len(matched)}")

    if not matched:
        print("ERROR: No matching EasyPost shipments found.")
        print("Check EasyPost dashboard — label may not be purchased, or address may differ.")
        sys.exit(1)

    for s in matched:
        to = s.get("to_address") or {}
        rate = s.get("selected_rate") or {}
        print(f"  → {s['id']} | {to.get('name')} | {to.get('street1')}, {to.get('zip')} "
              f"| {rate.get('carrier')} {rate.get('service')} | ${rate.get('rate')}")
        if "--debug" in args:
            rate = s.get("selected_rate") or {}
            print(f"    batch_id={s.get('batch_id')} | refund_status={s.get('refund_status')} | status={s.get('status')}")
            print(f"    tracking={s.get('tracking_code')}")
            print(f"    selected_rate.id={rate.get('id')} | rate=${rate.get('rate')} | carrier={rate.get('carrier')} | service={rate.get('service')}")

    # Deduplicate by selected_rate.id — multi-package shipments share one rate
    # across all package objects; only count each unique rate once.
    seen_rate_ids, deduped = set(), []
    for s in matched:
        rid = (s.get("selected_rate") or {}).get("id")
        if rid and rid in seen_rate_ids:
            continue
        if rid:
            seen_rate_ids.add(rid)
        deduped.append(s)
    if len(deduped) < len(matched):
        print(f"  (deduplicated {len(matched) - len(deduped)} duplicate rate(s) — multi-package shipment)")
    matched = deduped

    # Step 3: verify rates
    missing = [s for s in matched if not (s.get("selected_rate") or {}).get("rate")]
    if missing:
        print(f"ERROR: {len(missing)} shipment(s) have no selected_rate (unpurchased?):")
        for s in missing:
            print(f"  {s['id']}")
        sys.exit(1)

    # Step 4: calculate
    raw_total = sum(float(s["selected_rate"]["rate"]) for s in matched)
    marked_up = round(raw_total * SHIPPING_MARKUP, 2)
    print(f"\nStep 3: Fee calculation")
    print(f"  Raw EasyPost total: ${raw_total:.2f}")
    print(f"  +{int((SHIPPING_MARKUP - 1) * 100)}% markup:       ${marked_up:.2f}")

    if dry_run:
        print(f"\n[DRY RUN] Would write Shipping fee ${marked_up} to order #{visual_id}")
        print(f"[DRY RUN] Would change status → '{SHIPPED_STATUS}'")
        print("Done (dry run — no changes made).")
        sys.exit(0)

    # Step 5: write fee
    print(f"\nStep 4: Writing Shipping fee ${marked_up} to Printavo...")
    fee_res = gql("""
        mutation($parentId: ID!, $input: FeeInput!) {
            feeCreate(parentId: $parentId, input: $input) {
                id description unitPrice quantity amount
            }
        }
    """, {
        "parentId": internal_id,
        "input": {
            "description": "Shipping",
            "amount":      marked_up,
            "quantity":    1,
            "taxable":     False,
        },
    })

    fee = fee_res.get("feeCreate") or {}
    if not fee.get("id"):
        print(f"ERROR: feeCreate returned no ID — response: {fee_res}")
        print("Status NOT changed.")
        sys.exit(1)

    print(f"  ✓ Fee created! ID: {fee.get('id')} | Amount: ${fee.get('amount')}")

    # Step 6: change status
    print(f"\nStep 5: Changing status to '{SHIPPED_STATUS}'...")

    # Paginate through all statuses to find the target
    statuses, cursor = [], None
    for _ in range(10):
        q = """
        query($after: String) {
            statuses(first: 50, after: $after) {
                nodes { id name }
                pageInfo { hasNextPage endCursor }
            }
        }
        """
        page = gql(q, {"after": cursor})
        batch = page.get("statuses", {}).get("nodes", [])
        statuses.extend(batch)
        page_info = page.get("statuses", {}).get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        cursor = page_info.get("endCursor")
    print(f"  Found {len(statuses)} statuses. Looking for '{SHIPPED_STATUS}'...")
    target = next((s for s in statuses if s["name"].strip() == SHIPPED_STATUS), None)

    if not target:
        print(f"ERROR: Status '{SHIPPED_STATUS}' not found in Printavo.")
        print(f"Fee ${marked_up} was written. Update status manually.")
        sys.exit(1)

    status_res = gql("""
        mutation($id: ID!, $statusId: ID!) {
            invoiceUpdate(input: { id: $id, statusId: $statusId }) {
                invoice { visualId status { name } }
                errors { message }
            }
        }
    """, {"id": internal_id, "statusId": target["id"]})

    upd = status_res.get("invoiceUpdate") or {}
    if upd.get("errors"):
        print(f"ERROR: Status update failed: {upd['errors']}")
        print(f"Fee ${marked_up} was written. Update status manually.")
        sys.exit(1)

    new_status = (upd.get("invoice") or {}).get("status", {}).get("name", "?")
    print(f"  ✓ Status → {new_status}")

    print(f"\n{'='*50}")
    print(f"✓ SUCCESS — Order #{visual_id}")
    print(f"  Shipments matched: {len(matched)}")
    print(f"  Raw cost: ${raw_total:.2f}  →  Fee: ${marked_up:.2f} (with markup)")
    print(f"  Status: {new_status}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
