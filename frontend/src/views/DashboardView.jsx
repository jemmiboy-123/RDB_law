import React from "react";
import Card from "../components/Card.jsx";
import { fmtDate } from "../components/fmt.js";

function DashboardView({ payload }) {
  if (!payload) return null;

  return (
    <section className="stack">
      <div className="kpis">
        <article><h3>{payload.stats.active_cases}</h3><p>Active Cases</p></article>
        <article><h3>{payload.stats.upcoming_deadlines}</h3><p>Upcoming Deadlines</p></article>
        <article><h3>{payload.stats.open_tasks}</h3><p>Open Tasks</p></article>
        <article><h3>{payload.stats.unpaid_invoices}</h3><p>Unpaid Invoices</p></article>
      </div>
      <div className="two-col">
        <Card title="Active Cases">
          <table><thead><tr><th>Ref</th><th>Client</th><th>Status</th></tr></thead><tbody>
            {payload.active_cases?.map((item) => <tr key={item.id}><td>{item.reference_number}</td><td>{item.client.full_name}</td><td>{item.status}</td></tr>)}
          </tbody></table>
        </Card>
        <Card title="Upcoming Deadlines">
          <table><thead><tr><th>Date</th><th>Case</th><th>Type</th></tr></thead><tbody>
            {payload.upcoming_deadlines?.map((item) => <tr key={item.id}><td>{fmtDate(item.due_date)}</td><td>{item.case.reference_number}</td><td>{item.kind}</td></tr>)}
          </tbody></table>
        </Card>
      </div>
    </section>
  );
}

export default DashboardView;
