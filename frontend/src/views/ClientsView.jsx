import React from "react";
import { useState } from "react";
import { api } from "../api.js";
import Card from "../components/Card.jsx";

const EMPTY = { full_name: "", email: "", phone: "", address: "", company: "", notes: "", portal_user_id: "" };

function ClientsView({ user, payload, meta, onDone, setMessage, setError }) {
  const [form, setForm] = useState(EMPTY);
  const items = payload?.items || [];

  async function submit(event) {
    event.preventDefault();
    try {
      await api("/api/clients", {
        method: "POST",
        data: {
          ...form,
          portal_user_id: form.portal_user_id ? Number(form.portal_user_id) : null
        }
      });
      setForm(EMPTY);
      setMessage("Client created.");
      await onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="stack">
      {user.role !== "client" && (
        <form className="panel form-grid" onSubmit={submit}>
          <h3>New Client</h3>
          <div className="two-col compact">
            <input placeholder="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input placeholder="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </div>
          <input placeholder="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <textarea placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <select value={form.portal_user_id} onChange={(e) => setForm({ ...form, portal_user_id: e.target.value })}>
            <option value="">No portal user</option>
            {meta.users.filter((u) => u.role === "client").map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
          <button type="submit">Create Client</button>
        </form>
      )}
      <Card title="Client List">
        <table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Company</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.id}><td>{item.full_name}</td><td>{item.email}</td><td>{item.phone}</td><td>{item.company}</td></tr>)}
        </tbody></table>
      </Card>
    </section>
  );
}

export default ClientsView;
