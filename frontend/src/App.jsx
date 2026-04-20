import React, { useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import DashboardView from "./views/DashboardView.jsx";
import ClientsView from "./views/ClientsView.jsx";
import CasesView from "./views/CasesView.jsx";
import DocumentsView from "./views/DocumentsView.jsx";
import CalendarView from "./views/CalendarView.jsx";
import TasksView from "./views/TasksView.jsx";
import BillingView from "./views/BillingView.jsx";
import NotificationsView from "./views/NotificationsView.jsx";
import UsersView from "./views/UsersView.jsx";

const NAV = [
  { id: "dashboard", label: "Dashboard", roles: ["admin", "lawyer", "staff", "client"] },
  { id: "clients", label: "Clients", roles: ["admin", "lawyer", "staff"] },
  { id: "cases", label: "Cases", roles: ["admin", "lawyer", "staff", "client"] },
  { id: "documents", label: "Documents", roles: ["admin", "lawyer", "staff", "client"] },
  { id: "calendar", label: "Calendar", roles: ["admin", "lawyer", "staff", "client"] },
  { id: "tasks", label: "Tasks", roles: ["admin", "lawyer", "staff", "client"] },
  { id: "billing", label: "Billing", roles: ["admin", "lawyer", "staff", "client"] },
  { id: "notifications", label: "Notifications", roles: ["admin", "lawyer", "staff", "client"] },
  { id: "users", label: "User Admin", roles: ["admin"] }
];

function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState("dashboard");
  const [meta, setMeta] = useState({ cases: [], clients: [], users: [] });
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [login, setLogin] = useState({ email: "admin@lawfirm.local", password: "admin12345" });

  const visibleNav = useMemo(() => (user ? NAV.filter((item) => item.roles.includes(user.role)) : []), [user]);

  async function loadMeta() {
    setMeta(await api("/api/meta"));
  }

  async function loadView(target) {
    const routeMap = {
      dashboard: "/api/dashboard",
      clients: "/api/clients",
      cases: "/api/cases",
      documents: "/api/documents",
      calendar: "/api/calendar",
      tasks: "/api/tasks",
      billing: "/api/billing",
      notifications: "/api/notifications",
      users: "/api/users"
    };
    const res = await api(routeMap[target]);
    setData((prev) => ({ ...prev, [target]: res }));
  }

  async function bootstrap() {
    setLoading(true);
    setError("");
    try {
      const me = await api("/api/auth/me");
      setUser(me.user);
      await loadMeta();
      await loadView("dashboard");
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    bootstrap();
  }, []);

  async function refreshCurrent() {
    try {
      setError("");
      await loadMeta();
      await loadView(view);
    } catch (err) {
      setError(err.message);
    }
  }

  async function doLogin(event) {
    event.preventDefault();
    try {
      setError("");
      await api("/api/auth/login", { method: "POST", data: login });
      setMessage("Welcome back.");
      await bootstrap();
    } catch (err) {
      setError(err.message);
    }
  }

  async function doLogout() {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
  }

  if (loading) return <div className="splash">Loading Law OS...</div>;

  if (!user) {
    return (
      <main className="auth-wrap">
        <section className="auth-card">
          <div style={{textAlign:'center',marginBottom:20}}>
            <img src="/logo.png" alt="Logo" style={{width:100,height:100,objectFit:'contain',borderRadius:'50%',border:'2px solid rgba(212,175,55,.4)',background:'#0e1d31',padding:6}} />
            <div style={{marginTop:10,fontFamily:'Manrope,sans-serif',fontWeight:800,fontSize:'1rem',color:'#111827',lineHeight:1.4}}>
              Rex Dumlao Batay-An<br/><span style={{color:'#6b7280',fontWeight:600,fontSize:'.88rem'}}>Law Office</span>
            </div>
          </div>
          <p style={{textAlign:'center',marginBottom:20}}>Sign in to access your account</p>
          <form className="form-grid" onSubmit={doLogin}>
            <label>Email<input type="email" value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} /></label>
            <label>Password<input type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} /></label>
            <button type="submit">Sign In</button>
          </form>
          {error && <div className="notice error" style={{marginTop:12}}>{error}</div>}
        </section>
      </main>
    );
  }

  const initials = user.full_name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.png" alt="Logo" style={{width:64,height:64,objectFit:'contain',borderRadius:'50%',border:'2px solid rgba(212,175,55,.35)',background:'#0e1d31',padding:4}} />
          <span style={{fontFamily:'Manrope,sans-serif',fontSize:'.72rem',fontWeight:700,color:'#d4af37',letterSpacing:'.6px',textTransform:'uppercase',lineHeight:1.4,textAlign:'center'}}>Rex Dumlao Batay-An<br/>Law Office</span>
        </div>
        <div className="user-chip">
          <div className="user-chip-avatar">{initials}</div>
          <div>
            <strong>{user.full_name}</strong>
            <small>{user.role.toUpperCase()}</small>
          </div>
        </div>
        <nav>
          {visibleNav.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "nav-btn active" : "nav-btn"}
              onClick={async () => {
                setView(item.id);
                setError("");
                setMessage("");
                try {
                  await loadView(item.id);
                } catch (err) {
                  setError(err.message);
                }
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <button className="logout" onClick={doLogout}>Logout</button>
      </aside>
      <main className="content">
        <header className="top">
          <h2>{visibleNav.find((x) => x.id === view)?.label || "Dashboard"}</h2>
          <button className="refresh" onClick={refreshCurrent}>↻ Refresh</button>
        </header>
        {message && <div className="notice success">{message}</div>}
        {error && <div className="notice error">{error}</div>}

        {view === "dashboard" && <DashboardView payload={data.dashboard} />}
        {view === "clients" && <ClientsView user={user} payload={data.clients} meta={meta} onDone={refreshCurrent} setMessage={setMessage} setError={setError} />}
        {view === "cases" && <CasesView user={user} payload={data.cases} meta={meta} onDone={refreshCurrent} setMessage={setMessage} setError={setError} />}
        {view === "documents" && <DocumentsView user={user} payload={data.documents} meta={meta} onDone={refreshCurrent} setMessage={setMessage} setError={setError} />}
        {view === "calendar" && <CalendarView user={user} payload={data.calendar} meta={meta} onDone={refreshCurrent} setMessage={setMessage} setError={setError} />}
        {view === "tasks" && <TasksView user={user} payload={data.tasks} meta={meta} onDone={refreshCurrent} setMessage={setMessage} setError={setError} />}
        {view === "billing" && <BillingView user={user} payload={data.billing} meta={meta} onDone={refreshCurrent} setMessage={setMessage} setError={setError} />}
        {view === "notifications" && <NotificationsView payload={data.notifications} />}
        {view === "users" && <UsersView payload={data.users} onDone={refreshCurrent} setMessage={setMessage} setError={setError} />}
      </main>
    </div>
  );
}

export default App;
