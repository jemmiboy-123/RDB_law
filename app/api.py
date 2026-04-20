import os
import uuid
from datetime import date, datetime, timedelta

from flask import Blueprint, current_app, jsonify, request, send_from_directory
from flask_login import current_user, login_required, login_user, logout_user
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

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

api = Blueprint("api", __name__, url_prefix="/api")
ALLOWED_DOC_TYPES = {"pdf", "doc", "docx", "txt", "jpg", "jpeg", "png"}


def _json_error(message, status=400):
    return jsonify({"error": message}), status


def _role_required(*roles):
    def decorator(func):
        def wrapper(*args, **kwargs):
            if not current_user.is_authenticated:
                return _json_error("Authentication required", 401)
            if current_user.role not in roles:
                return _json_error("Forbidden", 403)
            return func(*args, **kwargs)

        wrapper.__name__ = func.__name__
        return wrapper

    return decorator


def _parse_date(value):
    return datetime.strptime(value, "%Y-%m-%d").date() if value else None


def _parse_datetime(value):
    return datetime.strptime(value, "%Y-%m-%dT%H:%M") if value else None


def _log_activity(action, target=""):
    db.session.add(ActivityLog(user_id=current_user.id if current_user.is_authenticated else None, action=action, target=target))


def _can_view_case(case):
    if current_user.role in {"admin", "lawyer", "staff"}:
        return True
    return current_user.role == "client" and current_user.client_profile and case.client_id == current_user.client_profile.id


def _allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_DOC_TYPES


def _user_json(user):
    return {
        "id": user.id,
        "full_name": user.full_name,
        "email": user.email,
        "role": user.role,
        "is_active_user": user.is_active_user,
    }


def _client_json(client):
    return {
        "id": client.id,
        "full_name": client.full_name,
        "email": client.email,
        "phone": client.phone,
        "address": client.address,
        "company": client.company,
        "notes": client.notes,
        "portal_user_id": client.portal_user_id,
    }


def _case_json(case):
    return {
        "id": case.id,
        "title": case.title,
        "reference_number": case.reference_number,
        "case_type": case.case_type,
        "description": case.description,
        "status": case.status,
        "opened_on": case.opened_on.isoformat() if case.opened_on else None,
        "closed_on": case.closed_on.isoformat() if case.closed_on else None,
        "client": {"id": case.client.id, "full_name": case.client.full_name},
        "lawyers": [{"id": l.id, "full_name": l.full_name} for l in case.lawyers],
    }


def _task_json(task):
    return {
        "id": task.id,
        "case": {"id": task.case.id, "reference_number": task.case.reference_number},
        "title": task.title,
        "details": task.details,
        "assignee": {"id": task.assignee.id, "full_name": task.assignee.full_name},
        "due_date": task.due_date.isoformat() if task.due_date else None,
        "status": task.status,
    }


@api.route("/auth/login", methods=["POST"])
def auth_login():
    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""
    user = User.query.filter_by(email=email, is_active_user=True).first()
    if not user or not check_password_hash(user.password_hash, password):
        return _json_error("Invalid credentials", 401)
    login_user(user)
    return jsonify({"user": _user_json(user)})


@api.route("/auth/logout", methods=["POST"])
@login_required
def auth_logout():
    logout_user()
    return jsonify({"ok": True})


@api.route("/auth/me")
def auth_me():
    if not current_user.is_authenticated:
        return _json_error("Authentication required", 401)
    return jsonify({"user": _user_json(current_user)})


@api.route("/dashboard")
@login_required
def dashboard():
    active_cases_q = Case.query.filter(Case.status != "closed")
    if current_user.role == "client" and current_user.client_profile:
        active_cases_q = active_cases_q.filter_by(client_id=current_user.client_profile.id)

    upcoming_deadlines_q = Deadline.query.filter(Deadline.due_date >= datetime.utcnow()).order_by(Deadline.due_date.asc())
    if current_user.role == "client" and current_user.client_profile:
        upcoming_deadlines_q = upcoming_deadlines_q.join(Case).filter(Case.client_id == current_user.client_profile.id)

    recent_activities = ActivityLog.query.order_by(ActivityLog.created_at.desc()).limit(12).all()

    open_tasks_q = Task.query.filter(Task.status != "done")
    if current_user.role == "client" and current_user.client_profile:
        open_tasks_q = open_tasks_q.join(Case).filter(Case.client_id == current_user.client_profile.id)
    elif current_user.role in {"lawyer", "staff"}:
        open_tasks_q = open_tasks_q.filter(Task.assignee_id == current_user.id)

    unpaid_invoices_q = Invoice.query.filter(Invoice.status.in_(["sent", "partial"])).join(Client)
    if current_user.role == "client":
        unpaid_invoices_q = unpaid_invoices_q.filter(Client.portal_user_id == current_user.id)

    return jsonify(
        {
            "stats": {
                "active_cases": active_cases_q.count(),
                "upcoming_deadlines": upcoming_deadlines_q.count(),
                "open_tasks": open_tasks_q.count(),
                "unpaid_invoices": unpaid_invoices_q.count(),
            },
            "active_cases": [_case_json(case) for case in active_cases_q.order_by(Case.updated_at.desc()).limit(8).all()],
            "upcoming_deadlines": [
                {
                    "id": d.id,
                    "title": d.title,
                    "due_date": d.due_date.isoformat(),
                    "kind": d.kind,
                    "case": {"id": d.case.id, "reference_number": d.case.reference_number},
                }
                for d in upcoming_deadlines_q.limit(8).all()
            ],
            "recent_activities": [
                {
                    "id": a.id,
                    "action": a.action,
                    "target": a.target,
                    "created_at": a.created_at.isoformat(),
                    "user": a.user.full_name if a.user else "System",
                }
                for a in recent_activities
            ],
        }
    )


@api.route("/meta")
@login_required
def meta():
    cases_q = Case.query
    clients_q = Client.query
    if current_user.role == "client" and current_user.client_profile:
        cases_q = cases_q.filter(Case.client_id == current_user.client_profile.id)
        clients_q = clients_q.filter(Client.id == current_user.client_profile.id)

    users_q = User.query.filter(User.role.in_(["admin", "lawyer", "staff", "client"]))
    if current_user.role == "client":
        users_q = users_q.filter(User.id == current_user.id)

    return jsonify(
        {
            "cases": [{"id": c.id, "reference_number": c.reference_number, "title": c.title} for c in cases_q.order_by(Case.reference_number.asc()).all()],
            "clients": [{"id": c.id, "full_name": c.full_name} for c in clients_q.order_by(Client.full_name.asc()).all()],
            "users": [{"id": u.id, "full_name": u.full_name, "role": u.role} for u in users_q.order_by(User.full_name.asc()).all()],
        }
    )


@api.route("/clients", methods=["GET", "POST"])
@login_required
def clients():
    if request.method == "GET":
        query = (request.args.get("q") or "").strip()
        if current_user.role == "client":
            if not current_user.client_profile:
                return jsonify({"items": []})
            return jsonify({"items": [_client_json(current_user.client_profile)]})
        clients_q = Client.query
        if query:
            clients_q = clients_q.filter(Client.full_name.ilike(f"%{query}%"))
        return jsonify({"items": [_client_json(c) for c in clients_q.order_by(Client.full_name.asc()).all()]})

    if current_user.role not in {"admin", "lawyer", "staff"}:
        return _json_error("Forbidden", 403)
    payload = request.get_json(silent=True) or {}
    client = Client(
        full_name=(payload.get("full_name") or "").strip(),
        email=(payload.get("email") or "").strip(),
        phone=(payload.get("phone") or "").strip(),
        address=(payload.get("address") or "").strip(),
        company=(payload.get("company") or "").strip(),
        notes=(payload.get("notes") or "").strip(),
        portal_user_id=payload.get("portal_user_id"),
    )
    if not client.full_name:
        return _json_error("full_name is required")
    db.session.add(client)
    _log_activity(f"Created client {client.full_name}", f"client:{client.full_name}")
    db.session.commit()
    return jsonify({"item": _client_json(client)}), 201


@api.route("/clients/<int:client_id>", methods=["GET", "PUT"])
@login_required
def client_detail(client_id):
    client = db.session.get(Client, client_id)
    if not client:
        return _json_error("Client not found", 404)

    if request.method == "GET":
        if current_user.role == "client" and client.portal_user_id != current_user.id:
            return _json_error("Forbidden", 403)
        cases = client.cases.order_by(Case.created_at.desc()).all()
        return jsonify({"item": _client_json(client), "case_history": [_case_json(c) for c in cases]})

    if current_user.role not in {"admin", "lawyer", "staff"}:
        return _json_error("Forbidden", 403)
    payload = request.get_json(silent=True) or {}
    for key in ["full_name", "email", "phone", "address", "company", "notes"]:
        if key in payload:
            setattr(client, key, (payload.get(key) or "").strip())
    if "portal_user_id" in payload:
        client.portal_user_id = payload.get("portal_user_id")
    _log_activity(f"Updated client {client.full_name}", f"client:{client.id}")
    db.session.commit()
    return jsonify({"item": _client_json(client)})


@api.route("/cases", methods=["GET", "POST"])
@login_required
def cases():
    if request.method == "GET":
        status = request.args.get("status")
        query = (request.args.get("q") or "").strip()
        cases_q = Case.query.join(Client)
        if current_user.role == "client" and current_user.client_profile:
            cases_q = cases_q.filter(Case.client_id == current_user.client_profile.id)
        if status:
            cases_q = cases_q.filter(Case.status == status)
        if query:
            cases_q = cases_q.filter(Case.title.ilike(f"%{query}%"))
        return jsonify({"items": [_case_json(c) for c in cases_q.order_by(Case.updated_at.desc()).all()]})

    if current_user.role not in {"admin", "lawyer", "staff"}:
        return _json_error("Forbidden", 403)
    payload = request.get_json(silent=True) or {}
    case = Case(
        title=(payload.get("title") or "").strip(),
        reference_number=(payload.get("reference_number") or "").strip(),
        case_type=(payload.get("case_type") or "").strip(),
        description=(payload.get("description") or "").strip(),
        status=(payload.get("status") or "open"),
        opened_on=_parse_date(payload.get("opened_on")) or date.today(),
        client_id=payload.get("client_id"),
    )
    if not case.title or not case.reference_number or not case.client_id:
        return _json_error("title, reference_number, client_id are required")
    lawyer_ids = payload.get("lawyer_ids") or []
    if lawyer_ids:
        case.lawyers = User.query.filter(User.id.in_(lawyer_ids)).all()
    db.session.add(case)
    _log_activity(f"Created case {case.reference_number}", f"case:{case.reference_number}")
    db.session.commit()
    return jsonify({"item": _case_json(case)}), 201


@api.route("/cases/<int:case_id>", methods=["GET", "PUT"])
@login_required
def case_detail(case_id):
    case = db.session.get(Case, case_id)
    if not case:
        return _json_error("Case not found", 404)
    if not _can_view_case(case):
        return _json_error("Forbidden", 403)

    if request.method == "GET":
        notes = case.notes.order_by(CaseNote.created_at.desc()).all()
        docs = case.documents.order_by(Document.created_at.desc()).limit(10).all()
        tasks = case.tasks.order_by(Task.created_at.desc()).limit(10).all()
        return jsonify(
            {
                "item": _case_json(case),
                "notes": [
                    {
                        "id": n.id,
                        "body": n.body,
                        "author": n.author.full_name,
                        "created_at": n.created_at.isoformat(),
                    }
                    for n in notes
                ],
                "documents": [
                    {
                        "id": d.id,
                        "original_name": d.original_name,
                        "category": d.category,
                        "created_at": d.created_at.isoformat(),
                    }
                    for d in docs
                ],
                "tasks": [_task_json(t) for t in tasks],
            }
        )

    if current_user.role not in {"admin", "lawyer", "staff"}:
        return _json_error("Forbidden", 403)
    payload = request.get_json(silent=True) or {}
    for key in ["title", "reference_number", "case_type", "description", "status"]:
        if key in payload:
            setattr(case, key, (payload.get(key) or "").strip() if key != "status" else payload.get(key) or "open")
    if "opened_on" in payload:
        case.opened_on = _parse_date(payload.get("opened_on"))
    if "closed_on" in payload:
        case.closed_on = _parse_date(payload.get("closed_on"))
    if "client_id" in payload:
        case.client_id = payload.get("client_id")
    if "lawyer_ids" in payload:
        case.lawyers = User.query.filter(User.id.in_(payload.get("lawyer_ids") or [])).all()

    _log_activity(f"Updated case {case.reference_number}", f"case:{case.id}")
    db.session.commit()
    return jsonify({"item": _case_json(case)})


@api.route("/cases/<int:case_id>/notes", methods=["POST"])
@login_required
@_role_required("admin", "lawyer", "staff")
def add_case_note(case_id):
    case = db.session.get(Case, case_id)
    if not case:
        return _json_error("Case not found", 404)
    payload = request.get_json(silent=True) or {}
    body = (payload.get("body") or "").strip()
    if not body:
        return _json_error("body is required")
    note = CaseNote(case_id=case.id, author_id=current_user.id, body=body)
    db.session.add(note)
    _log_activity(f"Added note to {case.reference_number}", f"case:{case.id}")
    db.session.commit()
    return jsonify({"item": {"id": note.id, "body": note.body, "author": current_user.full_name, "created_at": note.created_at.isoformat()}}), 201


@api.route("/documents", methods=["GET", "POST"])
@login_required
def documents():
    if request.method == "GET":
        query = (request.args.get("q") or "").strip()
        case_id = request.args.get("case_id", type=int)
        docs_q = Document.query.join(Case)
        if current_user.role == "client" and current_user.client_profile:
            docs_q = docs_q.filter(Case.client_id == current_user.client_profile.id)
        if query:
            docs_q = docs_q.filter(Document.original_name.ilike(f"%{query}%"))
        if case_id:
            docs_q = docs_q.filter(Document.case_id == case_id)
        return jsonify(
            {
                "items": [
                    {
                        "id": d.id,
                        "original_name": d.original_name,
                        "category": d.category,
                        "description": d.description,
                        "created_at": d.created_at.isoformat(),
                        "case": {"id": d.case.id, "reference_number": d.case.reference_number},
                    }
                    for d in docs_q.order_by(Document.created_at.desc()).all()
                ]
            }
        )

    if current_user.role not in {"admin", "lawyer", "staff"}:
        return _json_error("Forbidden", 403)
    file = request.files.get("file")
    case_id = request.form.get("case_id", type=int)
    case = db.session.get(Case, case_id) if case_id else None
    if not case:
        return _json_error("Valid case_id is required")
    if not file or not file.filename or not _allowed_file(file.filename):
        return _json_error("Unsupported or missing file")

    safe_name = secure_filename(file.filename)
    storage_name = f"{uuid.uuid4().hex}_{safe_name}"
    file.save(os.path.join(current_app.config["UPLOAD_FOLDER"], storage_name))

    doc = Document(
        case_id=case.id,
        uploaded_by_id=current_user.id,
        filename=storage_name,
        original_name=safe_name,
        category=(request.form.get("category") or "General").strip(),
        description=(request.form.get("description") or "").strip(),
    )
    db.session.add(doc)
    _log_activity(f"Uploaded document for {case.reference_number}", f"document:{safe_name}")
    db.session.commit()
    return jsonify({"item": {"id": doc.id, "original_name": doc.original_name}}), 201


@api.route("/documents/<int:doc_id>/download")
@login_required
def documents_download(doc_id):
    doc = db.session.get(Document, doc_id)
    if not doc:
        return _json_error("Document not found", 404)
    if not _can_view_case(doc.case):
        return _json_error("Forbidden", 403)
    return send_from_directory(current_app.config["UPLOAD_FOLDER"], doc.filename, as_attachment=True, download_name=doc.original_name)


@api.route("/calendar", methods=["GET", "POST"])
@login_required
def calendar():
    if request.method == "POST":
        if current_user.role not in {"admin", "lawyer", "staff"}:
            return _json_error("Forbidden", 403)
        payload = request.get_json(silent=True) or {}
        item = Deadline(
            case_id=payload.get("case_id"),
            title=(payload.get("title") or "").strip(),
            due_date=_parse_datetime(payload.get("due_date")),
            kind=(payload.get("kind") or "deadline").strip(),
        )
        if not item.case_id or not item.title or not item.due_date:
            return _json_error("case_id, title, due_date are required")
        db.session.add(item)
        db.session.flush()
        case = db.session.get(Case, item.case_id)
        for lawyer in case.lawyers:
            if lawyer.email:
                send_email_if_configured(
                    lawyer.email,
                    f"New {item.kind} for {case.reference_number}",
                    f"{item.title} is scheduled on {item.due_date:%Y-%m-%d %H:%M}.",
                )
        _log_activity(f"Added {item.kind} for {case.reference_number}", f"deadline:{item.id}")
        db.session.commit()
        return jsonify({"item": {"id": item.id}}), 201

    start = datetime.utcnow() - timedelta(days=7)
    deadlines_q = Deadline.query.filter(Deadline.due_date >= start).order_by(Deadline.due_date.asc())
    if current_user.role == "client" and current_user.client_profile:
        deadlines_q = deadlines_q.join(Case).filter(Case.client_id == current_user.client_profile.id)
    return jsonify(
        {
            "items": [
                {
                    "id": d.id,
                    "title": d.title,
                    "due_date": d.due_date.isoformat(),
                    "kind": d.kind,
                    "case": {"id": d.case.id, "reference_number": d.case.reference_number},
                }
                for d in deadlines_q.all()
            ]
        }
    )


@api.route("/tasks", methods=["GET", "POST"])
@login_required
def tasks():
    if request.method == "POST":
        if current_user.role not in {"admin", "lawyer", "staff"}:
            return _json_error("Forbidden", 403)
        payload = request.get_json(silent=True) or {}
        task = Task(
            case_id=payload.get("case_id"),
            title=(payload.get("title") or "").strip(),
            details=(payload.get("details") or "").strip(),
            assignee_id=payload.get("assignee_id"),
            due_date=_parse_date(payload.get("due_date")),
            status=(payload.get("status") or "todo").strip(),
        )
        if not task.case_id or not task.title or not task.assignee_id:
            return _json_error("case_id, title, assignee_id are required")
        db.session.add(task)
        db.session.flush()
        if task.assignee and task.assignee.email:
            send_email_if_configured(task.assignee.email, f"Task assigned: {task.title}", f"You have been assigned task '{task.title}'.")
        _log_activity(f"Created task {task.title}", f"task:{task.id}")
        db.session.commit()
        return jsonify({"item": _task_json(task)}), 201

    mine = request.args.get("mine") == "1"
    tasks_q = Task.query.join(Case)
    if current_user.role == "client" and current_user.client_profile:
        tasks_q = tasks_q.filter(Case.client_id == current_user.client_profile.id)
    elif mine or current_user.role in {"lawyer", "staff"}:
        tasks_q = tasks_q.filter(Task.assignee_id == current_user.id)
    return jsonify({"items": [_task_json(t) for t in tasks_q.order_by(Task.created_at.desc()).all()]})


@api.route("/tasks/<int:task_id>/status", methods=["PUT"])
@login_required
def task_status(task_id):
    task = db.session.get(Task, task_id)
    if not task:
        return _json_error("Task not found", 404)
    if current_user.role not in {"admin", "lawyer", "staff"}:
        return _json_error("Forbidden", 403)
    if current_user.role in {"lawyer", "staff"} and task.assignee_id != current_user.id:
        return _json_error("Forbidden", 403)
    payload = request.get_json(silent=True) or {}
    task.status = payload.get("status") or "todo"
    _log_activity(f"Updated task status to {task.status}", f"task:{task.id}")
    db.session.commit()
    return jsonify({"item": _task_json(task)})


@api.route("/billing")
@login_required
def billing_data():
    entries_q = TimeEntry.query.join(Case).join(Client)
    invoices_q = Invoice.query.join(Client)
    if current_user.role == "client" and current_user.client_profile:
        entries_q = entries_q.filter(Case.client_id == current_user.client_profile.id)
        invoices_q = invoices_q.filter(Invoice.client_id == current_user.client_profile.id)

    entries = entries_q.order_by(TimeEntry.entry_date.desc()).limit(50).all()
    invoices = invoices_q.order_by(Invoice.created_at.desc()).limit(25).all()
    return jsonify(
        {
            "entries": [
                {
                    "id": e.id,
                    "entry_date": e.entry_date.isoformat(),
                    "hours": e.hours,
                    "rate": e.rate,
                    "description": e.description,
                    "billed": e.billed,
                    "case": {"id": e.case.id, "reference_number": e.case.reference_number},
                    "lawyer": {"id": e.lawyer.id, "full_name": e.lawyer.full_name},
                }
                for e in entries
            ],
            "invoices": [
                {
                    "id": i.id,
                    "invoice_number": i.invoice_number,
                    "status": i.status,
                    "total": i.total,
                    "client": {"id": i.client.id, "full_name": i.client.full_name},
                }
                for i in invoices
            ],
        }
    )


@api.route("/billing/time-entries", methods=["POST"])
@login_required
@_role_required("admin", "lawyer")
def create_time_entry():
    payload = request.get_json(silent=True) or {}
    entry = TimeEntry(
        case_id=payload.get("case_id"),
        lawyer_id=payload.get("lawyer_id"),
        entry_date=_parse_date(payload.get("entry_date")) or date.today(),
        hours=float(payload.get("hours") or 0),
        rate=float(payload.get("rate") or 0),
        description=(payload.get("description") or "").strip(),
    )
    if not entry.case_id or not entry.lawyer_id or not entry.description:
        return _json_error("case_id, lawyer_id, description are required")
    db.session.add(entry)
    _log_activity(f"Added billable entry ({entry.hours}h)", f"case:{entry.case_id}")
    db.session.commit()
    return jsonify({"item": {"id": entry.id}}), 201


@api.route("/billing/invoices", methods=["POST"])
@login_required
@_role_required("admin", "lawyer")
def create_invoice():
    payload = request.get_json(silent=True) or {}
    client_id = payload.get("client_id")
    due_date = _parse_date(payload.get("due_date")) or date.today()
    tax_rate = float(payload.get("tax_rate") or 0)

    entries = (
        TimeEntry.query.join(Case)
        .filter(Case.client_id == client_id, TimeEntry.billed.is_(False))
        .order_by(TimeEntry.entry_date.asc())
        .all()
    )
    if not entries:
        return _json_error("No unbilled entries for this client")

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
    _log_activity(f"Generated invoice {invoice.invoice_number}", f"invoice:{invoice.id}")
    db.session.commit()
    return jsonify({"item": {"id": invoice.id, "invoice_number": invoice.invoice_number}}), 201


@api.route("/billing/invoices/<int:invoice_id>/payments", methods=["POST"])
@login_required
@_role_required("admin", "lawyer", "staff")
def add_payment(invoice_id):
    invoice = db.session.get(Invoice, invoice_id)
    if not invoice:
        return _json_error("Invoice not found", 404)
    payload = request.get_json(silent=True) or {}
    payment = Payment(
        invoice_id=invoice.id,
        amount=float(payload.get("amount") or 0),
        payment_date=_parse_date(payload.get("payment_date")) or date.today(),
        method=(payload.get("method") or "bank_transfer").strip(),
        reference=(payload.get("reference") or "").strip(),
    )
    db.session.add(payment)
    paid_total = sum(p.amount for p in invoice.payments) + payment.amount
    invoice.status = "paid" if paid_total >= invoice.total else ("partial" if paid_total > 0 else invoice.status)
    _log_activity(f"Recorded payment for {invoice.invoice_number}", f"invoice:{invoice.id}")
    db.session.commit()
    return jsonify({"item": {"id": payment.id}}), 201


@api.route("/users", methods=["GET", "POST"])
@login_required
@_role_required("admin")
def users():
    if request.method == "GET":
        return jsonify({"items": [_user_json(u) for u in User.query.order_by(User.created_at.desc()).all()]})

    payload = request.get_json(silent=True) or {}
    user = User(
        full_name=(payload.get("full_name") or "").strip(),
        email=(payload.get("email") or "").strip().lower(),
        password_hash=generate_password_hash(payload.get("password") or "TempPass123!"),
        role=(payload.get("role") or "staff").strip(),
        is_active_user=True,
    )
    if not user.full_name or not user.email:
        return _json_error("full_name and email are required")
    db.session.add(user)
    _log_activity(f"Created user {user.email}", f"user:{user.email}")
    db.session.commit()
    return jsonify({"item": _user_json(user)}), 201


@api.route("/notifications")
@login_required
def notifications():
    soon = datetime.utcnow() + timedelta(days=7)
    reminders_q = Deadline.query.filter(Deadline.due_date <= soon).order_by(Deadline.due_date.asc())
    if current_user.role == "client" and current_user.client_profile:
        reminders_q = reminders_q.join(Case).filter(Case.client_id == current_user.client_profile.id)

    overdue_tasks_q = Task.query.filter(Task.status != "done", Task.due_date < date.today()).order_by(Task.due_date.asc())
    if current_user.role == "client" and current_user.client_profile:
        overdue_tasks_q = overdue_tasks_q.join(Case).filter(Case.client_id == current_user.client_profile.id)
    elif current_user.role in {"lawyer", "staff"}:
        overdue_tasks_q = overdue_tasks_q.filter(Task.assignee_id == current_user.id)

    return jsonify(
        {
            "reminders": [
                {
                    "id": r.id,
                    "title": r.title,
                    "due_date": r.due_date.isoformat(),
                    "case": {"id": r.case.id, "reference_number": r.case.reference_number},
                }
                for r in reminders_q.all()
            ],
            "overdue_tasks": [_task_json(t) for t in overdue_tasks_q.all()],
        }
    )
