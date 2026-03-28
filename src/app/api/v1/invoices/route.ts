import { NextRequest, NextResponse } from "next/server";
import { listInvoices, getInvoiceState, getAuditLog } from "@/lib/db/store";

/**
 * GET /api/v1/invoices — List all invoices with state
 * GET /api/v1/invoices?invoice_id=xxx — Get specific invoice + audit trail
 */
export async function GET(request: NextRequest) {
  const invoiceId = request.nextUrl.searchParams.get("invoice_id");

  if (invoiceId) {
    const state = getInvoiceState(invoiceId);
    if (!state) {
      return NextResponse.json(
        { error: "Invoice not found" },
        { status: 404 }
      );
    }
    const audit = getAuditLog(invoiceId);
    return NextResponse.json({ invoice: state, audit });
  }

  return NextResponse.json({ invoices: listInvoices() });
}
