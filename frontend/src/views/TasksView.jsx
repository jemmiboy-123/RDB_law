import React, { useState } from "react";
import { api } from "../api.js";
import Card from "../components/Card.jsx";
import Badge from "../components/Badge.jsx";
import { fmtDate } from "../components/fmt.js";

function TasksView({ user, payload, meta, onDone, setMessage, setError }) {
  const [form, setForm] = useState({ case_id: "", title: "", details: "", assignee_id: "", due_date: "", status: "todo" });
  const items = payload?.items || [];

  async function submit(event) {
    event.preventDefault();
    try {
      await api("/api/tasks", {
        method: "POST",
        data: { ...form, case_id: Number(form.case_id), assignee_id: Number(form.assignee_id) },
      });
      setForm({ case_id: "", title: "", details: "", assignee_id: "", due_date: "", status: "todo" });
      setMessage("Task created.");
      await onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  async function setStatus(taskId, status) {
    try {
      await api(`/api/tasks/${taskId}/status`, { method: "PUT", data: { status } });
      await onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="stack">
      {user.role !== "client" && (
        <form className="panel form-grid" onSubmit={submit}>
          <h3>Create Task</h3>
          <label>Case
            <select value={form.case_id} onChange={(e) => setForm({ ...form, case_id: e.target.value })}>
              <option value="">Select case</option>
              {meta.cases.map((c) => <option key={c.id} value={c.id}>{c.reference_number}</option>)}
            </select>
          </label>
          <label>Task Title<input placeholder="e.g. File motion to dismiss" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label>Details<textarea placeholder="Additional details or instructions" value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} /></label>
          <div className="two-col compact">
            <label>Assign To
              <select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
                <option value="">Select assignee</option>
                {meta.users.filter((u) => ["admin", "lawyer", "staff"].includes(u.role)).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
            <label>Due Date<input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
          </div>
          <button type="submit">Create Task</button>
        </form>
      )}
      <Card title="Task Board">
        {items.length === 0
          ? <p className="empty-state">No tasks yet.</p>
          : <table>
              <thead><tr><th>Case</th><th>Task</th><th>Assignee</th><th>Due</th><th>Status</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.case.reference_number}</td>
                    <td>{item.title}</td>
                    <td>{item.assignee.full_name}</td>
                    <td>{fmtDate(item.due_date)}</td>
                    <td>
                      {user.role === "client"
                        ? <Badge value={item.status} />
                        : <select value={item.status} onChange={(e) => setStatus(item.id, e.target.value)}>
                            <option value="todo">To Do</option>
                            <option value="in_progress">In Progress</option>
                            <option value="done">Done</option>
                          </select>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
        }
      </Card>
    </section>
  );
}

export default TasksView;
