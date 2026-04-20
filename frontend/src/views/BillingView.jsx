import React from "react";
import { useState } from "react";
import { api } from "../api.js";
import Card from "../components/Card.jsx";

function BillingView({ user, payload, meta, onDone, setMessage, setError }) {
  const [entryForm, setEntryForm] = useState({ case_id: "", lawyer_id: "", entry_date: "", hours: "", rate: "", description: "" });
  const [invoiceForm, setInvoiceForm] = useState({ client_id: "", due_date: "", tax_rate: "0" });
  const [payments, setPayments] = useState({});

  const entries = payload?.entries || [];
  const invoices = payload?.invoices || [];

  async function addEntry(event) {
    event.preventDefault();
    try {
      await api("/api/billing/time-entries", {
        method: "POST",
        data: {
          ...entryForm,
          case_id: Number(entryForm.case_id),
          lawyer_id: Number(entryForm.lawyer_id),
          hours: Number(entryForm.hours),
          rate: Number(entryForm.rate)
        }
      });
      setEntryForm({ case_id: "", lawyer_id: "", entry_date: "", hours: "", rate: "", description: "" });
      setMessage("Time entry recorded.");
      await onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createInvoice(event) {
    event.preventDefault();
    try {
      await api("/api/billing/invoices", {
        method: "POST",
        data: { ...invoiceForm, client_id: Number(invoiceForm.client_id), tax_rate: Number(invoiceForm.tax_rate || 0) }
      });
      setMessage("Invoice generated.");
      await onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  async function recordPayment(invoiceId, event) {
    event.preventDefault();
    try {
      const form = payments[invoiceId] || { amount: "", method: "bank_transfer" };
      await api(`/api/billing/invoices/${invoiceId}/payments`, {
        method: "POST",
        data: { ...form, amount: Number(form.amount || 0) }
      });
      setMessage("Payment recorded.");
      await onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="stack">
      {user.role !== "client" && (
        <div className="two-col">
          <form className="panel form-grid" onSubmit={addEntry}>
            <h3>Log Billable Hours</h3>
            <select value={entryForm.case_id} onChange={(e) => setEntryForm({ ...entryForm, case_id: e.target.value })}>
              <option value="">Select case</option>
              {meta.cases.map((c) => <option key={c.id} value={c.id}>{c.reference_number}</option>)}
            </select>
            <select value={entryForm.lawyer_id} onChange={(e) => setEntryForm({ ...entryForm, lawyer_id: e.target.value })}>
              <option value="">Select lawyer</option>
              {meta.users.filter((u) => ["admin", "lawyer"].includes(u.role)).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
            <div className="two-col compact">
              <input type="date" value={entryForm.entry_date} onChange={(e) => setEntryForm({ ...entryForm, entry_date: e.target.value })} />
              <input type="number" step="0.1" placeholder="Hours" value={entryForm.hours} onChange={(e) => setEntryForm({ ...entryForm, hours: e.target.value })} />
            </div>
            <div className="two-col compact">
              <input type="number" step="0.01" placeholder="Rate" value={entryForm.rate} onChange={(e) => setEntryForm({ ...entryForm, rate: e.target.value })} />
              <input placeholder="Description" value={entryForm.description} onChange={(e) => setEntryForm({ ...entryForm, description: e.target.value })} />
            </div>
            <button type="submit">Add Time Entry</button>
          </form>

          <form className="panel form-grid" onSubmit={createInvoice}>
            <h3>Generate Invoice</h3>
            <select value={invoiceForm.client_id} onChange={(e) => setInvoiceForm({ ...invoiceForm, client_id: e.target.value })}>
              <option value="">Select client</option>
              {meta.clients.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </select>
            <input type="date" value={invoiceForm.due_date} onChange={(e) => setInvoiceForm({ ...invoiceForm, due_date: e.target.value })} />
            <input type="number" step="0.1" value={invoiceForm.tax_rate} onChange={(e) => setInvoiceForm({ ...invoiceForm, tax_rate: e.target.value })} />
            <button type="submit">Generate</button>
          </form>
        </div>
      )}

      <div className="two-col">
        <Card title="Recent Time Entries">
          <table><thead><tr><th>Date</th><th>Case</th><th>Lawyer</th><th>Hours</th><th>Billed</th></tr></thead><tbody>
            {entries.map((e) => <tr key={e.id}><td>{e.entry_date}</td><td>{e.case.reference_number}</td><td>{e.lawyer.full_name}</td><td>{e.hours}</td><td>{e.billed ? "Yes" : "No"}</td></tr>)}
          </tbody></table>
        </Card>
        <Card title="Invoices">
          <table><thead><tr><th>No.</th><th>Client</th><th>Total</th><th>Status</th><th>Payment</th></tr></thead><tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <td>{inv.invoice_number}</td><td>{inv.client.full_name}</td><td>{inv.total}</td><td>{inv.status}</td>
                <td>
                  {user.role === "client" ? "-" : (
                    <form className="inline-form" onSubmit={(e) => recordPayment(inv.id, e)}>
                      <input type="number" step="0.01" placeholder="Amount" value={payments[inv.id]?.amount || ""} onChange={(e) => setPayments({ ...payments, [inv.id]: { ...(payments[inv.id] || {}), amount: e.target.value, method: payments[inv.id]?.method || "bank_transfer" } })} />
                      <select value={payments[inv.id]?.method || "bank_transfer"} onChange={(e) => setPayments({ ...payments, [inv.id]: { ...(payments[inv.id] || {}), method: e.target.value } })}>
                        <option value="bank_transfer">Bank</option><option value="card">Card</option><option value="cash">Cash</option>
                      </select>
                      <button type="submit">Pay</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody></table>
        </Card>
      </div>
    </section>
  );
}

export default BillingView;
