import React from "react";
import { useState } from "react";
import { api } from "../api.js";
import Card from "../components/Card.jsx";

function UsersView({ payload, onDone, setMessage, setError }) {
  const [form, setForm] = useState({ full_name: "", email: "", password: "", role: "staff" });
  const items = payload?.items || [];

  async function submit(event) {
    event.preventDefault();
    try {
      await api("/api/users", { method: "POST", data: form });
      setForm({ full_name: "", email: "", password: "", role: "staff" });
      setMessage("User created.");
      await onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="stack">
      <form className="panel form-grid" onSubmit={submit}>
        <h3>Create User</h3>
        <div className="two-col compact">
          <input placeholder="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input placeholder="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="admin">Admin</option><option value="lawyer">Lawyer</option><option value="staff">Staff</option><option value="client">Client</option>
          </select>
        </div>
        <button type="submit">Create User</button>
      </form>
      <Card title="Users">
        <table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.id}><td>{item.full_name}</td><td>{item.email}</td><td>{item.role}</td></tr>)}
        </tbody></table>
      </Card>
    </section>
  );
}

export default UsersView;
