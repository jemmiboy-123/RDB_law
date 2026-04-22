import React from "react";
import Card from "../components/Card.jsx";
import Badge from "../components/Badge.jsx";
import { fmtDate } from "../components/fmt.js";

function NotificationsView({ payload }) {
  const reminders = payload?.reminders || [];
  const overdue = payload?.overdue_tasks || [];

  return (
    <section className="two-col">
      <Card title="Due This Week">
        {reminders.length === 0
          ? <p className="empty-state">Nothing due this week.</p>
          : <table>
              <thead><tr><th>Date</th><th>Case</th><th>Type</th><th>Title</th></tr></thead>
              <tbody>
                {reminders.map((item) => (
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
      <Card title="Overdue Tasks">
        {overdue.length === 0
          ? <p className="empty-state">No overdue tasks.</p>
          : <table>
              <thead><tr><th>Case</th><th>Task</th><th>Assignee</th></tr></thead>
              <tbody>
                {overdue.map((item) => (
                  <tr key={item.id}>
                    <td>{item.case.reference_number}</td>
                    <td>{item.title}</td>
                    <td>{item.assignee.full_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        }
      </Card>
    </section>
  );
}

export default NotificationsView;
