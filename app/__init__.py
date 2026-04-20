import os
import uuid
from datetime import date, datetime, timedelta

from flask import Flask, flash, jsonify, redirect, render_template, request, send_file, send_from_directory, url_for
from flask_login import LoginManager, current_user, login_required, login_user, logout_user
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

from .authz import role_required
from .config import Config
from .api import api as api_blueprint
from .models import (
    ActivityLog,
    Case,
    CaseNote,
    Client,
    Deadline,
    Document,
    Invoice,
    InvoiceItem,
    Payment,
    Task,
    TimeEntry,
    User,
    db,
)
from .notifications import send_email_if_configured

ALLOWED_DOC_TYPES = {"pdf", "doc", "docx", "txt", "jpg", "jpeg", "png"}


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)
    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

    db.init_app(app)
    login_manager = LoginManager()
    login_manager.login_view = "login"
    login_manager.init_app(app)

    @login_manager.unauthorized_handler
    def unauthorized():
        if request.path.startswith("/api/"):
            return jsonify({"error": "Authentication required"}), 401
        return redirect(url_for("login"))

    @login_manager.user_loader
    def load_user(user_id):
        return db.session.get(User, int(user_id))

    with app.app_context():
        db.create_all()
        seed_admin()

    app.register_blueprint(api_blueprint)

    def log_activity(action, target=""):
        db.session.add(ActivityLog(user_id=current_user.id if current_user.is_authenticated else None, action=action, target=target))

    def parse_date(raw):
        return datetime.strptime(raw, "%Y-%m-%d").date() if raw else None

    def parse_datetime(raw):
        return datetime.strptime(raw, "%Y-%m-%dT%H:%M") if raw else None

    def can_view_case(case):
        if current_user.role in {"admin", "lawyer", "staff"}:
            return True
        if current_user.role == "client" and case.client.portal_user_id == current_user.id:
            return True
        return False

    def allowed_file(filename):
        return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_DOC_TYPES

    @app.route("/")
    def index():
        if current_user.is_authenticated:
            return redirect(url_for("dashboard"))
        return redirect(url_for("login"))

    @app.route("/app")
    @app.route("/app/<path:resource>")
    def react_app(resource="index.html"):
        dist_root = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
        target = os.path.join(dist_root, resource)
        if os.path.exists(target) and os.path.isfile(target):
            return send_file(target)
        index_file = os.path.join(dist_root, "index.html")
        if os.path.exists(index_file):
            return send_file(index_file)
        return (
            "React app is not built yet. Run frontend with `npm run dev` in /frontend, "
            "or build it with `npm run build`.",
            404,
        )

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if request.method == "POST":
            email = request.form.get("email", "").strip().lower()
            password = request.form.get("password", "")
            user = User.query.filter_by(email=email, is_active_user=True).first()
            if user and check_password_hash(user.password_hash, password):
                login_user(user)
                return redirect(url_for("dashboard"))
            flash("Invalid credentials.", "error")
        return render_template("auth/login.html")

    @app.route("/logout")
    @login_required
    def logout():
        logout_user()
        return redirect(url_for("login"))

    @app.route("/dashboard")
    @login_required
    def dashboard():
        active_cases_q = Case.query.filter(Case.status != "closed")
        if current_user.role == "client" and current_user.client_profile:
            active_cases_q = active_cases_q.filter_by(client_id=current_user.client_profile.id)
        active_cases = active_cases_q.order_by(Case.updated_at.desc()).limit(8).all()

        upcoming_deadlines_q = Deadline.query.filter(Deadline.due_date >= datetime.utcnow()).order_by(Deadline.due_date.asc())
        if current_user.role == "client" and current_user.client_profile:
            upcoming_deadlines_q = upcoming_deadlines_q.join(Case).filter(Case.client_id == current_user.client_profile.id)
        upcoming_deadlines = upcoming_deadlines_q.limit(8).all()

        recent_activities = ActivityLog.query.order_by(ActivityLog.created_at.desc()).limit(10).all()
        open_tasks_q = Task.query.filter(Task.status != "done")
        if current_user.role == "client" and current_user.client_profile:
            open_tasks_q = open_tasks_q.join(Case).filter(Case.client_id == current_user.client_profile.id)
        elif current_user.role in {"lawyer", "staff"}:
            open_tasks_q = open_tasks_q.filter(Task.assignee_id == current_user.id)

        unpaid_invoices_q = Invoice.query.filter(Invoice.status.in_(["sent", "partial"])).join(Client)
        if current_user.role == "client":
            unpaid_invoices_q = unpaid_invoices_q.filter(Client.portal_user_id == current_user.id)
        stats = {
            "active_cases": active_cases_q.count(),
            "upcoming_deadlines": upcoming_deadlines_q.count(),
            "open_tasks": open_tasks_q.count(),
            "unpaid_invoices": unpaid_invoices_q.count(),
        }
        return render_template(
            "dashboard/index.html",
            active_cases=active_cases,
            upcoming_deadlines=upcoming_deadlines,
            recent_activities=recent_activities,
            stats=stats,
        )

    @app.route("/clients")
    @login_required
    @role_required("admin", "lawyer", "staff")
    def clients_list():
        query = request.args.get("q", "").strip()
        clients_q = Client.query
        if query:
            clients_q = clients_q.filter(Client.full_name.ilike(f"%{query}%"))
        clients = clients_q.order_by(Client.full_name.asc()).all()
        return render_template("clients/list.html", clients=clients, query=query)

    @app.route("/clients/new", methods=["GET", "POST"])
    @login_required
    @role_required("admin", "lawyer", "staff")
    def clients_new():
        client_users = User.query.filter_by(role="client").order_by(User.full_name.asc()).all()
        if request.method == "POST":
            client = Client(
                full_name=request.form.get("full_name", "").strip(),
                email=request.form.get("email", "").strip(),
                phone=request.form.get("phone", "").strip(),
                address=request.form.get("address", "").strip(),
                company=request.form.get("company", "").strip(),
                notes=request.form.get("notes", "").strip(),
                portal_user_id=request.form.get("portal_user_id") or None,
            )
            db.session.add(client)
            log_activity(f"Created client {client.full_name}", f"client:{client.full_name}")
            db.session.commit()
            flash("Client created.", "success")
            return redirect(url_for("clients_list"))
        return render_template("clients/form.html", client=None, client_users=client_users)

    @app.route("/clients/<int:client_id>/edit", methods=["GET", "POST"])
    @login_required
    @role_required("admin", "lawyer", "staff")
    def clients_edit(client_id):
        client = db.session.get(Client, client_id)
        if not client:
            return "Client not found", 404
        client_users = User.query.filter_by(role="client").order_by(User.full_name.asc()).all()
        if request.method == "POST":
            client.full_name = request.form.get("full_name", "").strip()
            client.email = request.form.get("email", "").strip()
            client.phone = request.form.get("phone", "").strip()
            client.address = request.form.get("address", "").strip()
            client.company = request.form.get("company", "").strip()
            client.notes = request.form.get("notes", "").strip()
            client.portal_user_id = request.form.get("portal_user_id") or None
            log_activity(f"Updated client {client.full_name}", f"client:{client.id}")
            db.session.commit()
            flash("Client updated.", "success")
            return redirect(url_for("clients_list"))
        return render_template("clients/form.html", client=client, client_users=client_users)

    @app.route("/clients/<int:client_id>")
    @login_required
    def clients_view(client_id):
        client = db.session.get(Client, client_id)
        if not client:
            return "Client not found", 404
        if current_user.role == "client" and client.portal_user_id != current_user.id:
            return "Forbidden", 403
        if current_user.role not in {"admin", "lawyer", "staff", "client"}:
            return "Forbidden", 403
        client_cases = client.cases.order_by(Case.created_at.desc()).all()
        return render_template("clients/view.html", client=client, client_cases=client_cases)

    @app.route("/cases")
    @login_required
    def cases_list():
        status = request.args.get("status", "")
        search = request.args.get("q", "").strip()

        cases_q = Case.query.join(Client)
        if current_user.role == "client" and current_user.client_profile:
            cases_q = cases_q.filter(Case.client_id == current_user.client_profile.id)
        if status:
            cases_q = cases_q.filter(Case.status == status)
        if search:
            cases_q = cases_q.filter(Case.title.ilike(f"%{search}%"))

        cases = cases_q.order_by(Case.updated_at.desc()).all()
        return render_template("cases/list.html", cases=cases, status=status, search=search)

    @app.route("/cases/new", methods=["GET", "POST"])
    @login_required
    @role_required("admin", "lawyer", "staff")
    def cases_new():
        clients = Client.query.order_by(Client.full_name.asc()).all()
        lawyers = User.query.filter(User.role.in_(["lawyer", "admin"]))
        lawyers = lawyers.order_by(User.full_name.asc()).all()
        if request.method == "POST":
            case = Case(
                title=request.form.get("title", "").strip(),
                reference_number=request.form.get("reference_number", "").strip(),
                case_type=request.form.get("case_type", "").strip(),
                description=request.form.get("description", "").strip(),
                status=request.form.get("status", "open"),
                opened_on=parse_date(request.form.get("opened_on")) or date.today(),
                client_id=int(request.form.get("client_id")),
            )
            selected_lawyers = request.form.getlist("lawyers")
            if selected_lawyers:
                case.lawyers = User.query.filter(User.id.in_(selected_lawyers)).all()
            db.session.add(case)
            log_activity(f"Created case {case.reference_number}", f"case:{case.reference_number}")
            db.session.commit()
            flash("Case created.", "success")
            return redirect(url_for("cases_view", case_id=case.id))
        return render_template("cases/form.html", case=None, clients=clients, lawyers=lawyers)

    @app.route("/cases/<int:case_id>/edit", methods=["GET", "POST"])
    @login_required
    @role_required("admin", "lawyer", "staff")
    def cases_edit(case_id):
        case = db.session.get(Case, case_id)
        if not case:
            return "Case not found", 404
        clients = Client.query.order_by(Client.full_name.asc()).all()
        lawyers = User.query.filter(User.role.in_(["lawyer", "admin"]))
        lawyers = lawyers.order_by(User.full_name.asc()).all()
        if request.method == "POST":
            case.title = request.form.get("title", "").strip()
            case.reference_number = request.form.get("reference_number", "").strip()
            case.case_type = request.form.get("case_type", "").strip()
            case.description = request.form.get("description", "").strip()
            case.status = request.form.get("status", "open")
            case.opened_on = parse_date(request.form.get("opened_on")) or date.today()
            case.closed_on = parse_date(request.form.get("closed_on"))
            case.client_id = int(request.form.get("client_id"))
            selected_lawyers = request.form.getlist("lawyers")
            case.lawyers = User.query.filter(User.id.in_(selected_lawyers)).all() if selected_lawyers else []
            log_activity(f"Updated case {case.reference_number}", f"case:{case.id}")
            db.session.commit()
            flash("Case updated.", "success")
            return redirect(url_for("cases_view", case_id=case.id))
        return render_template("cases/form.html", case=case, clients=clients, lawyers=lawyers)

    @app.route("/cases/<int:case_id>", methods=["GET", "POST"])
    @login_required
    def cases_view(case_id):
        case = db.session.get(Case, case_id)
        if not case:
            return "Case not found", 404
        if not can_view_case(case):
            return "Forbidden", 403
        if request.method == "POST" and current_user.role in {"admin", "lawyer", "staff"}:
            body = request.form.get("note", "").strip()
            if body:
                db.session.add(CaseNote(case_id=case.id, author_id=current_user.id, body=body))
                log_activity(f"Added note to {case.reference_number}", f"case:{case.id}")
                db.session.commit()
        notes = case.notes.order_by(CaseNote.created_at.desc()).all()
        documents = case.documents.order_by(Document.created_at.desc()).limit(5).all()
        tasks = case.tasks.order_by(Task.created_at.desc()).limit(5).all()
        return render_template("cases/view.html", case=case, notes=notes, documents=documents, tasks=tasks)

    @app.route("/documents", methods=["GET", "POST"])
    @login_required
    def documents_list():
        if request.method == "POST" and current_user.role in {"admin", "lawyer", "staff"}:
            file = request.files.get("file")
            case_id = int(request.form.get("case_id"))
            case = db.session.get(Case, case_id)
            if not file or not file.filename or not allowed_file(file.filename):
                flash("Unsupported or missing file.", "error")
                return redirect(url_for("documents_list"))
            safe_name = secure_filename(file.filename)
            storage_name = f"{uuid.uuid4().hex}_{safe_name}"
            file.save(os.path.join(app.config["UPLOAD_FOLDER"], storage_name))

            doc = Document(
                case_id=case.id,
                uploaded_by_id=current_user.id,
                filename=storage_name,
                original_name=safe_name,
                category=request.form.get("category", "General").strip(),
                description=request.form.get("description", "").strip(),
            )
            db.session.add(doc)
            log_activity(f"Uploaded document for {case.reference_number}", f"document:{safe_name}")
            db.session.commit()
            flash("Document uploaded.", "success")
            return redirect(url_for("documents_list"))

        query = request.args.get("q", "").strip()
        case_filter = request.args.get("case_id", "")
        docs_q = Document.query.join(Case)
        if current_user.role == "client" and current_user.client_profile:
            docs_q = docs_q.filter(Case.client_id == current_user.client_profile.id)
        if query:
            docs_q = docs_q.filter(Document.original_name.ilike(f"%{query}%"))
        if case_filter:
            docs_q = docs_q.filter(Document.case_id == int(case_filter))
        documents = docs_q.order_by(Document.created_at.desc()).all()
        cases_q = Case.query
        if current_user.role == "client" and current_user.client_profile:
            cases_q = cases_q.filter(Case.client_id == current_user.client_profile.id)
        cases = cases_q.order_by(Case.reference_number.asc()).all()
        return render_template("documents/list.html", documents=documents, cases=cases, query=query, case_filter=case_filter)

    @app.route("/documents/<int:doc_id>/download")
    @login_required
    def documents_download(doc_id):
        doc = db.session.get(Document, doc_id)
        if not doc:
            return "Document not found", 404
        if not can_view_case(doc.case):
            return "Forbidden", 403
        return send_from_directory(app.config["UPLOAD_FOLDER"], doc.filename, as_attachment=True, download_name=doc.original_name)

    @app.route("/calendar", methods=["GET", "POST"])
    @login_required
    def calendar_view():
        if request.method == "POST" and current_user.role in {"admin", "lawyer", "staff"}:
            dl = Deadline(
                case_id=int(request.form.get("case_id")),
                title=request.form.get("title", "").strip(),
                due_date=parse_datetime(request.form.get("due_date")),
                kind=request.form.get("kind", "deadline"),
            )
            db.session.add(dl)
            db.session.flush()
            case = db.session.get(Case, dl.case_id)
            for lawyer in case.lawyers:
                if lawyer.email:
                    send_email_if_configured(
                        lawyer.email,
                        f"New {dl.kind} for {case.reference_number}",
                        f"{dl.title} is scheduled on {dl.due_date:%Y-%m-%d %H:%M}.",
                    )
            log_activity(f"Added {dl.kind} for {case.reference_number}", f"deadline:{dl.id}")
            db.session.commit()
            flash("Calendar event added.", "success")
            return redirect(url_for("calendar_view"))

        start = datetime.utcnow() - timedelta(days=7)
        deadlines_q = Deadline.query.filter(Deadline.due_date >= start).order_by(Deadline.due_date.asc())
        if current_user.role == "client" and current_user.client_profile:
            deadlines_q = deadlines_q.join(Case).filter(Case.client_id == current_user.client_profile.id)
        deadlines = deadlines_q.all()
        cases_q = Case.query
        if current_user.role == "client" and current_user.client_profile:
            cases_q = cases_q.filter(Case.client_id == current_user.client_profile.id)
        cases = cases_q.order_by(Case.reference_number.asc()).all()
        return render_template("calendar/index.html", deadlines=deadlines, cases=cases)

    @app.route("/tasks", methods=["GET", "POST"])
    @login_required
    def tasks_view():
        if request.method == "POST" and current_user.role in {"admin", "lawyer", "staff"}:
            task = Task(
                case_id=int(request.form.get("case_id")),
                title=request.form.get("title", "").strip(),
                details=request.form.get("details", "").strip(),
                assignee_id=int(request.form.get("assignee_id")),
                due_date=parse_date(request.form.get("due_date")),
                status=request.form.get("status", "todo"),
            )
            db.session.add(task)
            db.session.flush()
            if task.assignee and task.assignee.email:
                send_email_if_configured(
                    task.assignee.email,
                    f"Task assigned: {task.title}",
                    f"You have been assigned task '{task.title}'.",
                )
            log_activity(f"Created task {task.title}", f"task:{task.id}")
            db.session.commit()
            flash("Task created.", "success")
            return redirect(url_for("tasks_view"))

        my_filter = request.args.get("mine") == "1"
        tasks_q = Task.query.join(Case)
        if current_user.role == "client" and current_user.client_profile:
            tasks_q = tasks_q.filter(Case.client_id == current_user.client_profile.id)
        elif my_filter or current_user.role in {"lawyer", "staff"}:
            tasks_q = tasks_q.filter(Task.assignee_id == current_user.id)
        tasks = tasks_q.order_by(Task.created_at.desc()).all()
        cases_q = Case.query
        if current_user.role == "client" and current_user.client_profile:
            cases_q = cases_q.filter(Case.client_id == current_user.client_profile.id)
        cases = cases_q.order_by(Case.reference_number.asc()).all()
        staff = User.query.filter(User.role.in_(["admin", "lawyer", "staff"]))
        staff = staff.order_by(User.full_name.asc()).all()
        return render_template("tasks/index.html", tasks=tasks, cases=cases, staff=staff)

    @app.route("/tasks/<int:task_id>/status", methods=["POST"])
    @login_required
    def tasks_status(task_id):
        task = db.session.get(Task, task_id)
        if not task:
            return "Task not found", 404
        if current_user.role not in {"admin", "lawyer", "staff"}:
            return "Forbidden", 403
        if current_user.role in {"lawyer", "staff"} and task.assignee_id != current_user.id:
            return "Forbidden", 403
        task.status = request.form.get("status", "todo")
        log_activity(f"Updated task status to {task.status}", f"task:{task.id}")
        db.session.commit()
        return redirect(url_for("tasks_view"))

    @app.route("/billing", methods=["GET", "POST"])
    @login_required
    def billing_index():
        if request.method == "POST" and current_user.role in {"admin", "lawyer"}:
            entry = TimeEntry(
                case_id=int(request.form.get("case_id")),
                lawyer_id=int(request.form.get("lawyer_id")),
                entry_date=parse_date(request.form.get("entry_date")) or date.today(),
                hours=float(request.form.get("hours", "0")),
                rate=float(request.form.get("rate", "0")),
                description=request.form.get("description", "").strip(),
            )
            db.session.add(entry)
            log_activity(f"Added billable entry ({entry.hours}h)", f"case:{entry.case_id}")
            db.session.commit()
            flash("Time entry recorded.", "success")
            return redirect(url_for("billing_index"))

        entries_q = TimeEntry.query.join(Case).join(Client)
        invoices_q = Invoice.query.join(Client)
        if current_user.role == "client" and current_user.client_profile:
            entries_q = entries_q.filter(Case.client_id == current_user.client_profile.id)
            invoices_q = invoices_q.filter(Invoice.client_id == current_user.client_profile.id)
        entries = entries_q.order_by(TimeEntry.entry_date.desc()).limit(50).all()
        invoices = invoices_q.order_by(Invoice.created_at.desc()).limit(25).all()

        cases_q = Case.query
        if current_user.role == "client" and current_user.client_profile:
            cases_q = cases_q.filter(Case.client_id == current_user.client_profile.id)
        cases = cases_q.order_by(Case.reference_number.asc()).all()
        lawyers = User.query.filter(User.role.in_(["admin", "lawyer"]))
        lawyers = lawyers.order_by(User.full_name.asc()).all()
        clients_q = Client.query
        if current_user.role == "client" and current_user.client_profile:
            clients_q = clients_q.filter(Client.id == current_user.client_profile.id)
        clients = clients_q.order_by(Client.full_name.asc()).all()
        return render_template(
            "billing/index.html",
            entries=entries,
            invoices=invoices,
            cases=cases,
            lawyers=lawyers,
            clients=clients,
        )

    @app.route("/billing/invoices/new", methods=["POST"])
    @login_required
    @role_required("admin", "lawyer")
    def billing_create_invoice():
        client_id = int(request.form.get("client_id"))
        due_date = parse_date(request.form.get("due_date")) or date.today()
        tax_rate = float(request.form.get("tax_rate", "0"))

        entries = (
            TimeEntry.query.join(Case)
            .filter(Case.client_id == client_id, TimeEntry.billed.is_(False))
            .order_by(TimeEntry.entry_date.asc())
            .all()
        )
        if not entries:
            flash("No unbilled entries for this client.", "error")
            return redirect(url_for("billing_index"))

        invoice = Invoice(
            invoice_number=f"INV-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
            client_id=client_id,
            issue_date=date.today(),
            due_date=due_date,
            status="sent",
        )
        db.session.add(invoice)
        db.session.flush()

        subtotal = 0.0
        for entry in entries:
            amount = entry.hours * entry.rate
            subtotal += amount
            db.session.add(
                InvoiceItem(
                    invoice_id=invoice.id,
                    time_entry_id=entry.id,
                    description=f"{entry.entry_date} - {entry.description}",
                    quantity=entry.hours,
                    unit_price=entry.rate,
                    line_total=amount,
                )
            )
            entry.billed = True

        invoice.subtotal = round(subtotal, 2)
        invoice.tax = round(subtotal * (tax_rate / 100), 2)
        invoice.total = round(invoice.subtotal + invoice.tax, 2)
        log_activity(f"Generated invoice {invoice.invoice_number}", f"invoice:{invoice.id}")
        db.session.commit()
        flash("Invoice generated from unbilled entries.", "success")
        return redirect(url_for("billing_index"))

    @app.route("/billing/invoices/<int:invoice_id>/payment", methods=["POST"])
    @login_required
    @role_required("admin", "lawyer", "staff")
    def billing_record_payment(invoice_id):
        invoice = db.session.get(Invoice, invoice_id)
        if not invoice:
            return "Invoice not found", 404
        payment = Payment(
            invoice_id=invoice.id,
            amount=float(request.form.get("amount", "0")),
            payment_date=parse_date(request.form.get("payment_date")) or date.today(),
            method=request.form.get("method", "bank_transfer"),
            reference=request.form.get("reference", "").strip(),
        )
        db.session.add(payment)
        paid_total = sum(p.amount for p in invoice.payments) + payment.amount
        if paid_total >= invoice.total:
            invoice.status = "paid"
        elif paid_total > 0:
            invoice.status = "partial"
        log_activity(f"Recorded payment for {invoice.invoice_number}", f"invoice:{invoice.id}")
        db.session.commit()
        flash("Payment recorded.", "success")
        return redirect(url_for("billing_index"))

    @app.route("/users", methods=["GET", "POST"])
    @login_required
    @role_required("admin")
    def users_admin():
        if request.method == "POST":
            user = User(
                full_name=request.form.get("full_name", "").strip(),
                email=request.form.get("email", "").strip().lower(),
                password_hash=generate_password_hash(request.form.get("password", "TempPass123!")),
                role=request.form.get("role", "staff"),
                is_active_user=True,
            )
            db.session.add(user)
            log_activity(f"Created user {user.email}", f"user:{user.email}")
            db.session.commit()
            flash("User created.", "success")
            return redirect(url_for("users_admin"))
        users = User.query.order_by(User.created_at.desc()).all()
        return render_template("users/index.html", users=users)

    @app.route("/notifications")
    @login_required
    def notifications_center():
        soon = datetime.utcnow() + timedelta(days=7)
        reminders_q = Deadline.query.filter(Deadline.due_date <= soon).order_by(Deadline.due_date.asc())
        if current_user.role == "client" and current_user.client_profile:
            reminders_q = reminders_q.join(Case).filter(Case.client_id == current_user.client_profile.id)
        reminders = reminders_q.all()

        overdue_tasks_q = Task.query.filter(Task.status != "done", Task.due_date < date.today()).order_by(Task.due_date.asc())
        if current_user.role == "client" and current_user.client_profile:
            overdue_tasks_q = overdue_tasks_q.join(Case).filter(Case.client_id == current_user.client_profile.id)
        elif current_user.role in {"lawyer", "staff"}:
            overdue_tasks_q = overdue_tasks_q.filter(Task.assignee_id == current_user.id)
        overdue_tasks = overdue_tasks_q.all()
        return render_template("dashboard/notifications.html", reminders=reminders, overdue_tasks=overdue_tasks)

    return app


def seed_admin():
    if not User.query.filter_by(email="admin@lawfirm.local").first():
        admin = User(
            full_name="System Administrator",
            email="admin@lawfirm.local",
            password_hash=generate_password_hash("admin12345"),
            role="admin",
            is_active_user=True,
        )
        db.session.add(admin)
        db.session.commit()
