import React from "react";
import { useState } from "react";
import { api } from "../api.js";
import Card from "../components/Card.jsx";
import { fmtDate } from "../components/fmt.js";

function DocumentsView({ user, payload, meta, onDone, setMessage, setError }) {
  const [form, setForm] = useState({ case_id: "", category: "", description: "", file: null });
  const items = payload?.items || [];

  async function submit(event) {
    event.preventDefault();
    try {
      const formData = new FormData();
      formData.append("case_id", form.case_id);
      formData.append("category", form.category);
      formData.append("description", form.description);
      if (form.file) formData.append("file", form.file);
      await api("/api/documents", { method: "POST", formData });
      setForm({ case_id: "", category: "", description: "", file: null });
      setMessage("Document uploaded.");
      await onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="stack">
      {user.role !== "client" && (
        <form className="panel form-grid" onSubmit={submit}>
          <h3>Upload Document</h3>
          <select value={form.case_id} onChange={(e) => setForm({ ...form, case_id: e.target.value })}>
            <option value="">Select case</option>
            {meta.cases.map((c) => <option key={c.id} value={c.id}>{c.reference_number}</option>)}
          </select>
          <div className="two-col compact">
            <input placeholder="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <input placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <input type="file" onChange={(e) => setForm({ ...form, file: e.target.files[0] || null })} />
          <button type="submit">Upload</button>
        </form>
      )}

      <Card title="Documents">
        <table><thead><tr><th>Name</th><th>Case</th><th>Category</th><th>Date</th><th></th></tr></thead><tbody>
          {items.map((d) => <tr key={d.id}><td>{d.original_name}</td><td>{d.case.reference_number}</td><td>{d.category}</td><td>{fmtDate(d.created_at)}</td><td><a href={`/api/documents/${d.id}/download`}>Download</a></td></tr>)}
        </tbody></table>
      </Card>
    </section>
  );
}

export default DocumentsView;
