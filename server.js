/**
 * EasyPost → Printavo Shipping Fee Automation
 *
 * Triggered by Printavo webhook on status change.
 * When an order hits a COMPLETED status with a UPS delivery method:
 *  1. Looks up EasyPost shipments by matching the order's shipping address
 *  2. Sums selected_rate.rate across all matched shipments
 *  3. Applies 10% markup and writes a Shipping fee to the Printavo invoice
 *  4. Changes order status to ORDER SHIPPED & INVOICED (triggers invoice email)
 *  5. Sends Slack DM to Luke on any error
 */

'use strict';

const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── ENVIRONMENT ──────────────────────────────────────────────────────────────

const PRINTAVO_EMAIL     = process.env.PRINTAVO_EMAIL     || '';
const PRINTAVO_TOKEN     = process.env.PRINTAVO_TOKEN     || '';
const EASYPOST_API_KEY   = process.env.EASYPOST_API_KEY   || '';
const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN    || '';
const SLACK_LUKE_USER_ID = process.env.SLACK_LUKE_USER_ID || 'U0504FSDYB0'; // Luke's Slack user ID
const PORT               = process.env.PORT               || 3000;

// ── ALERT DEDUPLICATION ───────────────────────────────────────────────────────
// Tracks order IDs we've already alerted about so we don't spam on repeated polls.
// Key: "orderId:errorType" — resets on restart (acceptable for a manual-run service).
const alertedOrders = new Set();

const PRINTAVO_GQL = 'https://www.printavo.com/api/v2';

// ── TRIGGER CONFIG ───────────────────────────────────────────────────────────

// Exact status names (case-insensitive match) that trigger processing.
// "DTF - COMPLETE" is the actual Printavo name; include the spec variant too.
const TRIGGER_STATUSES = [
  'SP - CONTRACT - COMPLETED',
  'SP - DIRECT - COMPLETED',
  'DTF - COMPLETE',
  'DTF - COMPLETED',          // variant spelling
  'EMB - CONTRACT - COMPLETE',
  'EMB - CONTRACT - COMPLETED', // variant spelling
  'EMB - DIRECT - COMPLETE',
  'EMB - DIRECT - COMPLETED',  // variant spelling
];

// Exact delivery method names (case-insensitive) that should be processed.
// Orders with any other delivery method are silently ignored.
const UPS_DELIVERY_METHODS = [
  'UPS Ground',
  'UPS 2 Day',
  'UPS Overnight',
];

// Final status name to set after fee is written.
const SHIPPED_STATUS_NAME = 'ORDER SHIPPED & INVOICED';

// How many days back to search EasyPost shipments for address matching.
const EASYPOST_LOOKBACK_DAYS = 14;

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Execute a Printavo GraphQL query/mutation.
 */
async function printavoQuery(query, variables = {}) {
  const res = await axios.post(
    PRINTAVO_GQL,
    { query, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        email: PRINTAVO_EMAIL,
        token: PRINTAVO_TOKEN,
      },
      timeout: 20000,
    }
  );

  if (res.data.errors && res.data.errors.length > 0) {
    throw new Error(`Printavo GQL error: ${JSON.stringify(res.data.errors)}`);
  }
  return res.data.data;
}

/**
 * Send a Slack DM directly to Luke using the Web API.
 * Uses SLACK_BOT_TOKEN + chat.postMessage so the message goes to Luke's DMs,
 * not a channel. Falls back to console error if no token is set.
 *
 * @param {string} message   - Alert body text
 * @param {string} [dedupeKey] - Optional key; if provided and already seen, skip sending
 */
async function slackAlert(message, dedupeKey) {
  if (dedupeKey) {
    if (alertedOrders.has(dedupeKey)) {
      console.log(`[slack] Suppressing duplicate alert for key: ${dedupeKey}`);
      return;
    }
    alertedOrders.add(dedupeKey);
  }

  if (!SLACK_BOT_TOKEN) {
    console.error('[slack] No SLACK_BOT_TOKEN set — cannot send DM alert');
    console.error('[slack] MESSAGE:', message);
    return;
  }
  try {
    const res = await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        channel: SLACK_LUKE_USER_ID,
        text: `🚨 *EasyPost→Printavo*\n${message}`,
      },
      {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    if (!res.data.ok) {
      console.error('[slack] chat.postMessage failed:', res.data.error);
    }
  } catch (err) {
    console.error('[slack] Failed to send DM alert:', err.message);
  }
}

/**
 * Normalize an address string for fuzzy matching
 * (lowercase, strip non-alphanumeric).
 */
function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Query EasyPost for purchased shipments and find ones whose to_address
 * matches the Printavo invoice's shipping address.
 *
 * Workaround: Printavo does not expose EasyPost shipment IDs via GraphQL.
 * We match by zip + street (or zip + name) within the last N days.
 */
async function findMatchingShipments(shippingAddress) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - EASYPOST_LOOKBACK_DAYS);

  // Fetch up to 100 purchased shipments; paginate if needed
  let allShipments = [];
  let beforeId = null;

  for (let page = 0; page < 5; page++) {
    const params = {
      purchased: true,
      page_size: 100,
      start_datetime: startDate.toISOString(),
    };
    if (beforeId) params.before_id = beforeId;

    const res = await axios.get('https://api.easypost.com/v2/shipments', {
      auth: { username: EASYPOST_API_KEY, password: '' },
      params,
      timeout: 20000,
    });

    const batch = res.data.shipments || [];
    allShipments = allShipments.concat(batch);

    // EasyPost paginates with has_more / last item ID
    if (!res.data.has_more || batch.length === 0) break;
    beforeId = batch[batch.length - 1].id;
  }

  console.log(`[easypost] Fetched ${allShipments.length} purchased shipments in last ${EASYPOST_LOOKBACK_DAYS} days`);

  // Build match tokens from the Printavo shipping address
  const invZip    = norm(shippingAddress.zipCode || shippingAddress.zip || '');
  const invStreet = norm(shippingAddress.address1 || shippingAddress.street1 || '');
  const invName   = norm(shippingAddress.customerName || shippingAddress.name || '');

  if (!invZip) {
    throw new Error('Invoice shipping address has no zip code — cannot match EasyPost shipments');
  }

  const matches = allShipments.filter(s => {
    const addr = s.to_address || {};

    const shipZip    = norm(addr.zip);
    const shipStreet = norm(addr.street1 || '');
    const shipName   = norm(addr.name || '');

    if (invZip !== shipZip) return false; // zip must match exactly

    // Street prefix match (first 8 chars after normalization)
    const streetMatch = invStreet.length >= 4 && shipStreet.startsWith(invStreet.slice(0, 8));

    // Name prefix match (first 5 chars after normalization)
    const nameMatch = invName.length >= 3 && shipName.includes(invName.slice(0, 5));

    return streetMatch || nameMatch;
  });

  return matches;
}

/**
 * Fetch all Printavo statuses and find "ORDER SHIPPED & INVOICED".
 * Returns the status node { id, name } or null if not found.
 */
async function findShippedStatus() {
  let allStatuses = [];
  let cursor = null;

  for (let page = 0; page < 10; page++) {
    const data = await printavoQuery(`
      query($after: String) {
        statuses(first: 50, after: $after) {
          nodes { id name }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { after: cursor });

    const batch = data?.statuses?.nodes || [];
    allStatuses = allStatuses.concat(batch);

    if (!data?.statuses?.pageInfo?.hasNextPage) break;
    cursor = data.statuses.pageInfo.endCursor;
  }

  return allStatuses.find(s => s.name.trim() === SHIPPED_STATUS_NAME) || null;
}

// ── CORE PROCESSOR ───────────────────────────────────────────────────────────

/**
 * Main processing logic for a completed order.
 *
 * @param {string} invoiceId   - Printavo internal GraphQL ID
 * @param {string} visualId    - Human-readable order number
 * @param {string} statusName  - The status that triggered this
 * @param {string} deliveryName - Delivery method name
 */
async function processOrder(invoiceId, visualId, statusName, deliveryName) {
  const tag = `Order #${visualId}`;
  console.log(`[process] ${tag} | status="${statusName}" | delivery="${deliveryName}"`);

  // ── Step 1: Fetch invoice details (shipping address + existing fees) ─────
  const invoiceData = await printavoQuery(`
    query GetInvoice($id: ID!) {
      invoice(id: $id) {
        id
        visualId
        shippingAddress {
          customerName
          address1
          address2
          city
          state
          zipCode
          country
        }
        fees {
          nodes {
            id
            description
            amount
          }
        }
      }
    }
  `, { id: invoiceId });

  const invoice = invoiceData?.invoice;
  if (!invoice) {
    await slackAlert(`${tag}: Could not retrieve invoice from Printavo. Status NOT changed.`);
    return;
  }

  // Idempotency: skip if a non-zero shipping fee already exists
  const existingFees = invoice.fees?.nodes || [];
  const realShipping = existingFees.find(f =>
    (f.description || '').toLowerCase().includes('shipping') && parseFloat(f.amount || 0) > 0
  );
  if (realShipping) {
    console.log(`[process] ${tag}: Shipping fee $${realShipping.amount} already exists — skipping`);
    return;
  }

  const shippingAddress = invoice.shippingAddress;
  if (!shippingAddress || !shippingAddress.zipCode) {
    await slackAlert(
      `${tag}: Invoice has no shipping address. Cannot look up EasyPost shipments. Status NOT changed.`,
      `${invoiceId}:no-address`
    );
    return;
  }

  // ── Step 2: Find EasyPost shipments for this order ───────────────────────
  let shipments;
  try {
    shipments = await findMatchingShipments(shippingAddress);
  } catch (err) {
    await slackAlert(`${tag}: EasyPost lookup error — ${err.message}. Status NOT changed.`);
    return;
  }

  if (shipments.length === 0) {
    await slackAlert(
      `${tag} (${statusName}): No EasyPost shipments found matching ` +
      `${shippingAddress.address1}, ${shippingAddress.zipCode}.\n` +
      `Check EasyPost dashboard. Status NOT changed.`,
      `${invoiceId}:no-shipments`
    );
    return;
  }

  // ── Step 2b: Deduplicate by selected_rate.id ─────────────────────────────
  // Multi-package EasyPost shipments share one rate_xxx across all package
  // objects. Summing without deduplication double-counts the total.
  const seenRateIds = new Set();
  shipments = shipments.filter(s => {
    const rid = s.selected_rate?.id;
    if (rid && seenRateIds.has(rid)) return false;
    if (rid) seenRateIds.add(rid);
    return true;
  });
  console.log(`[process] ${tag}: ${shipments.length} unique rate(s) after deduplication`);

  // ── Step 3: Verify all matched shipments have a purchased rate ───────────
  const missingRate = shipments.filter(s => !s.selected_rate?.rate);
  if (missingRate.length > 0) {
    await slackAlert(
      `${tag}: ${missingRate.length} of ${shipments.length} matched shipment(s) have no selected_rate.\n` +
      `IDs: ${missingRate.map(s => s.id).join(', ')}\n` +
      `Label may not be purchased yet. Status NOT changed.`
    );
    return;
  }

  // ── Step 4: Sum rates + 10% markup ───────────────────────────────────────
  const rawTotal  = shipments.reduce((sum, s) => sum + parseFloat(s.selected_rate.rate), 0);
  const markedUp  = Math.round(rawTotal * 1.10 * 100) / 100;

  console.log(
    `[process] ${tag}: ${shipments.length} shipment(s) | raw $${rawTotal.toFixed(2)} | ` +
    `+10% = $${markedUp.toFixed(2)}`
  );

  // ── Step 5: Write Shipping fee to Printavo ────────────────────────────────
  let feeData;
  try {
    feeData = await printavoQuery(`
      mutation CreateFee($parentId: ID!, $input: FeeInput!) {
        feeCreate(parentId: $parentId, input: $input) {
          id
          description
          unitPrice
          quantity
          amount
        }
      }
    `, {
      parentId: invoice.id,
      input: {
        description: 'Shipping',
        amount:      markedUp,
        quantity:    1,
        taxable:     false,
      },
    });
  } catch (err) {
    await slackAlert(
      `${tag}: feeCreate threw an error — ${err.message}.\n` +
      `Fee NOT written. Status NOT changed.`
    );
    return;
  }

  const createdFee = feeData?.feeCreate;
  if (!createdFee?.id) {
    await slackAlert(
      `${tag}: feeCreate returned no fee ID — response: ${JSON.stringify(feeData)}.\n` +
      `Fee NOT written. Status NOT changed.`
    );
    return;
  }

  console.log(`[process] ${tag}: Shipping fee $${markedUp} written ✓ (fee ID: ${createdFee.id})`);

  // ── Step 6: Change status to ORDER SHIPPED & INVOICED ────────────────────
  let shippedStatus;
  try {
    shippedStatus = await findShippedStatus();
  } catch (err) {
    await slackAlert(
      `${tag}: Fee $${markedUp} written ✓ but failed to look up status "${SHIPPED_STATUS_NAME}" — ` +
      `${err.message}. Please update status manually.`
    );
    return;
  }

  if (!shippedStatus) {
    await slackAlert(
      `${tag}: Fee $${markedUp} written ✓ but status "${SHIPPED_STATUS_NAME}" not found in Printavo. ` +
      `Please create that status or update the order manually.`
    );
    return;
  }

  let statusData;
  try {
    statusData = await printavoQuery(`
      mutation UpdateStatus($id: ID!, $statusId: ID!) {
        invoiceUpdate(input: { id: $id, statusId: $statusId }) {
          invoice {
            id
            visualId
            status { name }
          }
          errors {
            message
          }
        }
      }
    `, {
      id:       invoice.id,
      statusId: shippedStatus.id,
    });
  } catch (err) {
    await slackAlert(
      `${tag}: Fee $${markedUp} written ✓ but status update threw — ${err.message}. ` +
      `Please update status manually.`
    );
    return;
  }

  const statusErrors = statusData?.invoiceUpdate?.errors || [];
  if (statusErrors.length > 0) {
    await slackAlert(
      `${tag}: Fee $${markedUp} written ✓ but status update failed — ${JSON.stringify(statusErrors)}. ` +
      `Please update status to "${SHIPPED_STATUS_NAME}" manually.`
    );
    return;
  }

  const newStatusName = statusData?.invoiceUpdate?.invoice?.status?.name || SHIPPED_STATUS_NAME;
  console.log(`[process] ${tag}: Status → "${newStatusName}" ✓  — all done`);
}

// ── POLLER ────────────────────────────────────────────────────────────────────

// ── AUTO-POLL DISABLED ────────────────────────────────────────────────────────
// Auto-polling is intentionally OFF. Run manually via POST /run until the
// workflow is fully validated. Re-enable by restoring the setInterval call
// at the bottom of this file and setting POLL_INTERVAL_MS.
//
// const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Poll Printavo for orders that are in a trigger status with a UPS delivery
 * method and don't yet have a shipping fee. Process each one.
 */
async function pollPrintavo() {
  console.log('[poll] Checking Printavo for completed UPS orders...');
  try {
    // Fetch recent invoices across all trigger statuses.
    // We query each status name individually since Printavo's search is text-based.
    const allInvoices = [];

    for (const statusName of TRIGGER_STATUSES) {
      const data = await printavoQuery(`
        query($q: String) {
          invoices(first: 20, query: $q) {
            nodes {
              id
              visualId
              status { name }
              deliveryMethod { name }
              fees { nodes { description amount } }
              shippingAddress {
                customerName
                address1
                city
                state
                zipCode
              }
            }
          }
        }
      `, { q: statusName });

      const nodes = data?.invoices?.nodes || [];
      for (const inv of nodes) {
        // Exact status match
        if (inv.status?.name?.trim() !== statusName) continue;
        allInvoices.push(inv);
      }
    }

    // Deduplicate by invoice ID (same order may match multiple status queries)
    const seen = new Set();
    const candidates = allInvoices.filter(inv => {
      if (seen.has(inv.id)) return false;
      seen.add(inv.id);
      return true;
    });

    console.log(`[poll] Found ${candidates.length} candidate order(s) in trigger statuses`);

    for (const inv of candidates) {
      const deliveryName = inv.deliveryMethod?.name || '';
      const isUPS = UPS_DELIVERY_METHODS.some(
        d => d.toLowerCase() === deliveryName.trim().toLowerCase()
      );
      if (!isUPS) continue;

      // Idempotency: skip if real shipping fee already exists
      const existingFees = inv.fees?.nodes || [];
      const hasShipping = existingFees.some(f =>
        (f.description || '').toLowerCase().includes('shipping') &&
        parseFloat(f.amount || 0) > 0
      );
      if (hasShipping) continue;

      console.log(`[poll] Processing order #${inv.visualId} (${inv.status?.name})`);
      processOrder(inv.id, inv.visualId, inv.status?.name, deliveryName).catch(err => {
        console.error(`[poll] Error on #${inv.visualId}:`, err.message);
        slackAlert(`Poll error on order #${inv.visualId}: ${err.message}`);
      });
    }
  } catch (err) {
    console.error('[poll] Error during poll:', err.message);
    slackAlert(`Poller error: ${err.message}`);
  }
}

// ── EXPRESS ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'easypost-printavo-shipping', version: '2.0.0' });
});

// Manual trigger endpoint — POST /run to force a poll immediately
app.post('/run', async (req, res) => {
  res.json({ message: 'Poll triggered' });
  pollPrintavo();
});

app.listen(PORT, () => {
  console.log(`EasyPost→Printavo service listening on port ${PORT}`);
  if (!PRINTAVO_EMAIL || !PRINTAVO_TOKEN) console.warn('⚠️  PRINTAVO_EMAIL or PRINTAVO_TOKEN not set');
  if (!EASYPOST_API_KEY)  console.warn('⚠️  EASYPOST_API_KEY not set');
  if (!SLACK_BOT_TOKEN)   console.warn('⚠️  SLACK_BOT_TOKEN not set — Slack DM alerts disabled');
  console.log('ℹ️  Auto-polling is DISABLED. Trigger manually via POST /run.');
  // AUTO-POLL DISABLED — manual mode only until workflow is fully validated.
  // To re-enable: uncomment the two lines below and set POLL_INTERVAL_MS above.
  // pollPrintavo();
  // setInterval(pollPrintavo, POLL_INTERVAL_MS);
});
