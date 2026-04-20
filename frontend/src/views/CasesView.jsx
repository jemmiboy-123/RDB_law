import React from "react";
import { useState } from "react";
import { api } from "../api.js";
import Card from "../components/Card.jsx";
import { fmtDate } from "../components/fmt.js";

const EMPTY = {
  title: "",
  reference_number: "",
  case_type: "",
  description: "",
  status: "open",
  opened_on: "",
  client_id: "",
  lawyer_ids: []
};

function CasesView({ user, payload, meta, onDone, setMessage, setError }) {
  const [form, setForm] = useState(EMPTY);
  const [detail, setDetail] = useState(null);
  const [note, setNote] = useState("");
  const items = payload?.items || [];

  async function submitCase(event) {
    event.preventDefault();
    try {
      await api("/api/cases", {
        method: "POST",
        data: {
          ...form,
          client_id: Number(form.client_id),
          lawyer_ids: form.lawyer_ids.map(Number)
        }
      });
      setForm(EMPTY);
      setMessage("Case created.");
      await onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  async function openCase(caseId) {
    try {
      setDetail(await api(`/api/cases/${caseId}`));
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitNote(event) {
    event.preventDefault();
    if (!detail?.item?.id) return;
    try {
      await api(`/api/cases/${detail.item.id}/notes`, { method: "POST", data: { body: note } });
      setNote("");
      setDetail(await api(`/api/cases/${detail.item.id}`));
      setMessage("Case note added.");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="stack">
      {user.role !== "client" && (
        <form className="panel form-grid" onSubmit={submitCase}>
          <h3>New Case</h3>
          <div className="two-col compact">
            <input placeholder="Case title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input placeholder="Reference number" value={form.reference_number} onChange={(e) => setForm({ ...form, reference_number: e.target.value })} />
            <input placeholder="Case type" value={form.case_type} onChange={(e) => setForm({ ...form, case_type: e.target.value })} />
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="open">Open</option><option value="pending">Pending</option><option value="closed">Closed</option></select>
          </div>
          <textarea placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div className="two-col compact">
            <select value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
              <option value="">Select client</option>
              {meta.clients.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </select>
            <input type="date" value={form.opened_on} onChange={(e) => setForm({ ...form, opened_on: e.target.value })} />
          </div>
          <select multiple value={form.lawyer_ids} onChange={(e) => setForm({ ...form, lawyer_ids: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
            {meta.users.filter((u) => ["admin", "lawyer"].includes(u.role)).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
          <button type="submit">Create Case</button>
        </form>
      )}

      <Card title="Case List">
        <table><thead><tr><th>Ref</th><th>Title</th><th>Client</th><th>Status</th></tr></thead><tbody>
          {items.map((item) => (
            <tr key={item.id} onClick={() => openCase(item.id)}>
              <td>{item.reference_number}</td><td>{item.title}</td><td>{item.client.full_name}</td><td>{item.status}</td>
            </tr>
          ))}
        </tbody></table>
      </Card>

      {detail && (
        <div className="two-col">
          <Card title={`Notes for ${detail.item.reference_number}`}>
            {user.role !== "client" && (
              <form className="form-grid" onSubmit={submitNote}>
                <textarea placeholder="Add note" value={note} onChange={(e) => setNote(e.target.value)} />
                <button type="submit">Add Note</button>
              </form>
            )}
            <table><thead><tr><th>When</th><th>Author</th><th>Note</th></tr></thead><tbody>
              {detail.notes.map((item) => <tr key={item.id}><td>{fmtDate(item.created_at)}</td><td>{item.author}</td><td>{item.body}</td></tr>)}
            </tbody></table>
          </Card>
          <Card title="Case Details">
            <p><strong>Status:</strong> {detail.item.status}</p>
            <p><strong>Opened:</strong> {detail.item.opened_on}</p>
            <p><strong>Lawyers:</strong> {detail.item.lawyers.map((l) => l.full_name).join(", ") || "-"}</p>
            <p><strong>Description:</strong> {detail.item.description || "-"}</p>
          </Card>
        </div>
      )}
    </section>
  );
}

export default CasesView;
