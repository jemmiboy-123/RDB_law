import React from "react";
import Card from "../components/Card.jsx";
import Badge from "../components/Badge.jsx";
import { fmtDate } from "../components/fmt.js";

const KPI_ICONS = {
  cases: (
    <svg className="kpi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="9" width="20" height="13" rx="2"/><path d="M8 9V7a4 4 0 0 1 8 0v2"/>
    </svg>
  ),
  deadlines: (
    <svg className="kpi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>
    </svg>
  ),
  tasks: (
    <svg className="kpi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/>
    </svg>
  ),
  invoices: (
    <svg className="kpi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 12h20M7 17h4"/>
    </svg>
  ),
};

function DashboardView({ payload }) {
  if (!payload) return null;

  return (
    <section className="stack">
      <div className="kpis">
        <article>
          {KPI_ICONS.cases}
          <h3>{payload.stats.active_cases}</h3>
          <p>Active Cases</p>
        </article>
        <article>
          {KPI_ICONS.deadlines}
          <h3>{payload.stats.upcoming_deadlines}</h3>
          <p>Upcoming Deadlines</p>
        </article>
        <article>
          {KPI_ICONS.tasks}
          <h3>{payload.stats.open_tasks}</h3>
          <p>Open Tasks</p>
        </article>
        <article>
          {KPI_ICONS.invoices}
          <h3>{payload.stats.unpaid_invoices}</h3>
          <p>Unpaid Invoices</p>
        </article>
      </div>
      <div className="two-col">
        <Card title="Active Cases">
          {payload.active_cases?.length === 0
            ? <p className="empty-state">No active cases.</p>
            : <table>
                <thead><tr><th>Ref</th><th>Client</th><th>Status</th></tr></thead>
                <tbody>
                  {payload.active_cases?.map((item) => (
                    <tr key={item.id}>
                      <td>{item.reference_number}</td>
                      <td>{item.client.full_name}</td>
                      <td><Badge value={item.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
          }
        </Card>
        <Card title="Upcoming Deadlines">
          {payload.upcoming_deadlines?.length === 0
            ? <p className="empty-state">No upcoming deadlines.</p>
            : <table>
                <thead><tr><th>Date</th><th>Case</th><th>Type</th></tr></thead>
                <tbody>
                  {payload.upcoming_deadlines?.map((item) => (
                    <tr key={item.id}>
                      <td>{fmtDate(item.due_date)}</td>
                      <td>{item.case.reference_number}</td>
                      <td><Badge value={item.kind} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
          }
        </Card>
      </div>
    </section>
  );
}

export default DashboardView;
