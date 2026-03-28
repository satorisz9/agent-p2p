/**
 * Demo: Full invoice flow
 *
 * 1. Register two agents (billing + AP)
 * 2. billing issues invoice
 * 3. AP receives, validates, accepts
 * 4. AP sends payment.notice
 *
 * Run: npx tsx scripts/demo-flow.ts
 */

const BASE = process.env.BASE_URL || "http://localhost:3030/api/v1";

// We need to generate keys and sign locally for the demo
// For simplicity, we'll use the crypto modules directly

async function main() {
  // Dynamic imports for ESM compat
  const { generateKeyPair, toBase64 } = await import("../src/lib/crypto/keys");
  const { buildSignedEnvelope } = await import("../src/lib/protocol/envelope");

  console.log("=== Agent P2P Invoice Demo ===\n");

  // --- Step 1: Generate key pairs ---
  const billingKeys = generateKeyPair();
  const apKeys = generateKeyPair();

  console.log("Generated key pairs for billing and AP agents");

  // --- Step 2: Register agents ---
  const billingAgent = {
    agent_id: "agent:mindaxis:billing",
    org_id: "org:mindaxis",
    public_key: toBase64(billingKeys.publicKey),
    algorithm: "Ed25519",
    endpoint: `${BASE}/mailboxes/agent:mindaxis:billing`,
    capabilities: [
      "invoice.issue",
      "invoice.cancel",
    ],
    status: "active",
    created_at: new Date().toISOString(),
  };

  const apAgent = {
    agent_id: "agent:vendorx:ap",
    org_id: "org:vendorx",
    public_key: toBase64(apKeys.publicKey),
    algorithm: "Ed25519",
    endpoint: `${BASE}/mailboxes/agent:vendorx:ap`,
    capabilities: [
      "invoice.ack",
      "invoice.accept",
      "invoice.reject",
      "invoice.request_fix",
      "payment.notice",
    ],
    status: "active",
    created_at: new Date().toISOString(),
  };

  await fetch(`${BASE}/agents/agent:mindaxis:billing`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(billingAgent),
  });
  console.log("Registered: agent:mindaxis:billing");

  await fetch(`${BASE}/agents/agent:vendorx:ap`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(apAgent),
  });
  console.log("Registered: agent:vendorx:ap\n");

  // --- Step 3: Issue invoice ---
  const invoicePayload = {
    meta: {
      invoice_id: "inv_2026_03_000123",
      currency: "JPY" as const,
    },
    data: {
      invoice_number: "MA-2026-03001",
      issue_date: "2026-03-29",
      due_date: "2026-04-30",
      seller: {
        org_id: "org:mindaxis",
        name: "MindAxis Inc.",
        tax_id: "T1234567890123",
        address: "Tokyo, Japan",
        email: "billing@mindaxis.example",
      },
      buyer: {
        org_id: "org:vendorx",
        name: "Vendor X Ltd.",
        tax_id: "T9876543210987",
        address: "Osaka, Japan",
        email: "ap@vendorx.example",
      },
      purchase_order_ref: "PO-2026-00118",
      contract_ref: "CTR-2026-008",
      line_items: [
        {
          line_id: "1",
          description: "AI automation support",
          quantity: 1,
          unit: "project",
          unit_price: 300000,
          tax_rate: 0.1,
          amount_excluding_tax: 300000,
          tax_amount: 30000,
          amount_including_tax: 330000,
        },
      ],
      subtotal: 300000,
      tax_total: 30000,
      total: 330000,
      payment_terms: {
        method: "bank_transfer" as const,
        bank_account_ref: "bank_account_01",
        terms_text: "Net 30",
      },
      notes: "Thank you for your business.",
    },
  };

  const envelope = buildSignedEnvelope(
    {
      from: "agent:mindaxis:billing",
      to: "agent:vendorx:ap",
      messageType: "invoice.issue",
      threadId: "thr_inv_2026_03_000123",
      idempotencyKey: "issue-inv_2026_03_000123-v1",
      expiresAt: "2026-04-30T23:59:59Z",
    },
    invoicePayload,
    billingKeys.privateKey,
    "key_2026_01"
  );

  console.log("Sending invoice.issue...");
  const issueRes = await fetch(`${BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope, payload: invoicePayload }),
  });
  const issueResult = await issueRes.json();
  console.log(`Response (${issueRes.status}):`, JSON.stringify(issueResult, null, 2));

  // --- Step 4: Check invoice state ---
  console.log("\nChecking invoice state...");
  const stateRes = await fetch(
    `${BASE}/invoices?invoice_id=inv_2026_03_000123`
  );
  const stateResult = await stateRes.json();
  console.log("Invoice state:", JSON.stringify(stateResult, null, 2));

  // --- Step 5: Check mailbox ---
  console.log("\nChecking AP mailbox...");
  const mailboxRes = await fetch(
    `${BASE}/mailboxes/agent:vendorx:ap/messages`
  );
  const mailboxResult = await mailboxRes.json();
  console.log(`Mailbox has ${mailboxResult.count} message(s)`);

  // --- Step 6: Try duplicate (idempotency test) ---
  console.log("\nSending duplicate invoice (idempotency test)...");
  const dupRes = await fetch(`${BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope, payload: invoicePayload }),
  });
  const dupResult = await dupRes.json();
  console.log(`Duplicate response (${dupRes.status}):`, dupResult.error || dupResult.status);

  console.log("\n=== Demo complete ===");
}

main().catch(console.error);
