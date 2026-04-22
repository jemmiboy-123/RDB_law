import React, { useState } from "react";
import { api } from "../api.js";
import Card from "../components/Card.jsx";
import Badge from "../components/Badge.jsx";
import { fmtDate } from "../components/fmt.js";

const EMPTY = {
  title: "",
  reference_number: "",
  case_type: "",
  description: "",
  status: "open",
  opened_on: "",
  client_id: "",
  lawyer_ids: [],
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
        data: { ...form, client_id: Number(form.client_id), lawyer_ids: form.lawyer_ids.map(Number) },
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
      setMessage("Note added.");
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
            <label>Title<input placeholder="e.g. Estate settlement" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label>Reference No.<input placeholder="e.g. RDB-2024-001" value={form.reference_number} onChange={(e) => setForm({ ...form, reference_number: e.target.value })} /></label>
            <label>Case Type<input placeholder="e.g. Civil, Criminal" value={form.case_type} onChange={(e) => setForm({ ...form, case_type: e.target.value })} /></label>
            <label>Status
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="open">Open</option>
                <option value="pending">Pending</option>
                <option value="closed">Closed</option>
              </select>
            </label>
          </div>
          <label>Description<textarea placeholder="Brief case description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <div className="two-col compact">
            <label>Client
              <select value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
                <option value="">Select client</option>
                {meta.clients.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
              </select>
            </label>
            <label>Date Opened<input type="date" value={form.opened_on} onChange={(e) => setForm({ ...form, opened_on: e.target.value })} /></label>
          </div>
          <label>Assigned Lawyers
            <select multiple value={form.lawyer_ids} onChange={(e) => setForm({ ...form, lawyer_ids: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
              {meta.users.filter((u) => ["admin", "lawyer"].includes(u.role)).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </label>
          <button type="submit">Create Case</button>
        </form>
      )}

      <Card title="Case List">
        {items.length === 0
          ? <p className="empty-state">No cases yet.</p>
          : <table>
              <thead><tr><th>Ref</th><th>Title</th><th>Client</th><th>Status</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="clickable" onClick={() => openCase(item.id)}>
                    <td>{item.reference_number}</td>
                    <td>{item.title}</td>
                    <td>{item.client.full_name}</td>
                    <td><Badge value={item.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
        }
      </Card>

      {detail && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontFamily: "Manrope,sans-serif", fontSize: ".78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: "var(--muted)" }}>
              Case Detail — {detail.item.reference_number}
            </span>
            <button className="btn-ghost" style={{ fontSize: ".8rem", padding: "4px 12px" }} onClick={() => setDetail(null)}>✕ Close</button>
          </div>
          <div className="two-col">
            <Card title={`Notes`}>
              {user.role !== "client" && (
                <form className="form-grid" onSubmit={submitNote} style={{ marginBottom: 16 }}>
                  <label>Add Note<textarea placeholder="Write a note…" value={note} onChange={(e) => setNote(e.target.value)} /></label>
                  <button type="submit">Add Note</button>
                </form>
              )}
              {detail.notes.length === 0
                ? <p className="empty-state">No notes yet.</p>
                : <table>
                    <thead><tr><th>When</th><th>Author</th><th>Note</th></tr></thead>
                    <tbody>
                      {detail.notes.map((item) => (
                        <tr key={item.id}>
                          <td style={{ whiteSpace: "nowrap" }}>{fmtDate(item.created_at)}</td>
                          <td>{item.author}</td>
                          <td>{item.body}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
              }
            </Card>
            <Card title="Case Details">
              <dl className="detail-list">
                <dt>Status</dt><dd><Badge value={detail.item.status} /></dd>
                <dt>Opened</dt><dd>{fmtDate(detail.item.opened_on)}</dd>
                <dt>Type</dt><dd>{detail.item.case_type || "—"}</dd>
                <dt>Client</dt><dd>{detail.item.client?.full_name || "—"}</dd>
                <dt>Lawyers</dt><dd>{detail.item.lawyers?.map((l) => l.full_name).join(", ") || "—"}</dd>
                <dt>Description</dt><dd style={{ whiteSpace: "pre-wrap" }}>{detail.item.description || "—"}</dd>
              </dl>
            </Card>
          </div>
        </div>
      )}
    </section>
  );
}

export default CasesView;
