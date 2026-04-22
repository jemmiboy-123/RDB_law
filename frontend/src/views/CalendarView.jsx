import React, { useState } from "react";
import { api } from "../api.js";
import Card from "../components/Card.jsx";
import Badge from "../components/Badge.jsx";
import { fmtDate } from "../components/fmt.js";

function CalendarView({ user, payload, meta, onDone, setMessage, setError }) {
  const [form, setForm] = useState({ case_id: "", title: "", due_date: "", kind: "deadline" });
  const items = payload?.items || [];

  async function submit(event) {
    event.preventDefault();
    try {
      await api("/api/calendar", { method: "POST", data: { ...form, case_id: Number(form.case_id) } });
      setForm({ case_id: "", title: "", due_date: "", kind: "deadline" });
      setMessage("Calendar event added.");
      await onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="stack">
      {user.role !== "client" && (
        <form className="panel form-grid" onSubmit={submit}>
          <h3>New Court Date / Deadline</h3>
          <label>Case
            <select value={form.case_id} onChange={(e) => setForm({ ...form, case_id: e.target.value })}>
              <option value="">Select case</option>
              {meta.cases.map((c) => <option key={c.id} value={c.id}>{c.reference_number}</option>)}
            </select>
          </label>
          <label>Title<input placeholder="e.g. Preliminary hearing" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <div className="two-col compact">
            <label>Date & Time<input type="datetime-local" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
            <label>Type
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="deadline">Deadline</option>
                <option value="court_date">Court Date</option>
              </select>
            </label>
          </div>
          <button type="submit">Add Event</button>
        </form>
      )}
      <Card title="Timeline">
        {items.length === 0
          ? <p className="empty-state">No events scheduled.</p>
          : <table>
              <thead><tr><th>Date</th><th>Case</th><th>Type</th><th>Title</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDate(item.due_date)}</td>
                    <td>{item.case.reference_number}</td>
                    <td><Badge value={item.kind} /></td>
                    <td>{item.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        }
      </Card>
    </section>
  );
}

export default CalendarView;
