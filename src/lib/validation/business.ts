import type { InvoiceIssuePayload, FixIssue } from "@/types/protocol";

export interface BusinessValidationResult {
  valid: boolean;
  fatalError?: string;
  fixableIssues: FixIssue[];
}

/**
 * Layer 3: Business validation for invoice.issue payloads.
 * Checks PO reference, tax consistency, totals, etc.
 */
export function validateBusinessRules(
  payload: InvoiceIssuePayload
): BusinessValidationResult {
  const issues: FixIssue[] = [];
  const { data } = payload;

  // Check: subtotal matches sum of line items
  const computedSubtotal = data.line_items.reduce(
    (sum, item) => sum + item.amount_excluding_tax,
    0
  );
  if (computedSubtotal !== data.subtotal) {
    issues.push({
      code: "subtotal_mismatch",
      field: "subtotal",
      message: `Subtotal ${data.subtotal} does not match sum of line items ${computedSubtotal}`,
    });
  }

  // Check: tax_total matches sum of line item taxes
  const computedTax = data.line_items.reduce(
    (sum, item) => sum + item.tax_amount,
    0
  );
  if (computedTax !== data.tax_total) {
    issues.push({
      code: "tax_amount_inconsistent",
      field: "tax_total",
      message: `Tax total ${data.tax_total} does not match sum of line item taxes ${computedTax}`,
    });
  }

  // Check: total = subtotal + tax_total
  if (data.subtotal + data.tax_total !== data.total) {
    issues.push({
      code: "total_mismatch",
      field: "total",
      message: `Total ${data.total} does not equal subtotal ${data.subtotal} + tax ${data.tax_total}`,
    });
  }

  // Check: due_date is after issue_date
  if (data.due_date <= data.issue_date) {
    issues.push({
      code: "invalid_due_date",
      field: "due_date",
      message: "Due date must be after issue date",
    });
  }

  // Check: each line item's tax_amount is consistent with tax_rate
  for (const item of data.line_items) {
    const expectedTax = Math.round(item.amount_excluding_tax * item.tax_rate);
    if (Math.abs(item.tax_amount - expectedTax) > 1) {
      // allow 1 yen rounding
      issues.push({
        code: "line_tax_inconsistent",
        field: `line_items[${item.line_id}].tax_amount`,
        message: `Line ${item.line_id}: tax ${item.tax_amount} inconsistent with rate ${item.tax_rate} * ${item.amount_excluding_tax}`,
      });
    }
  }

  return {
    valid: issues.length === 0,
    fixableIssues: issues,
  };
}
