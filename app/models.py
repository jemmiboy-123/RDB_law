from datetime import datetime, date

from flask_login import UserMixin
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import Index


db = SQLAlchemy()


case_lawyers = db.Table(
    "case_lawyers",
    db.Column("case_id", db.Integer, db.ForeignKey("case.id"), primary_key=True),
    db.Column("user_id", db.Integer, db.ForeignKey("user.id"), primary_key=True),
)


class TimestampMixin:
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class User(UserMixin, TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    full_name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(160), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, index=True)  # admin, lawyer, staff, client
    is_active_user = db.Column(db.Boolean, default=True, nullable=False)

    tasks = db.relationship("Task", back_populates="assignee", lazy="dynamic")
    time_entries = db.relationship("TimeEntry", back_populates="lawyer", lazy="dynamic")
    client_profile = db.relationship("Client", back_populates="portal_user", uselist=False)

    def __repr__(self):
        return f"<User {self.email}>"


class Client(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    full_name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(160), index=True)
    phone = db.Column(db.String(40))
    address = db.Column(db.String(255))
    company = db.Column(db.String(120))
    notes = db.Column(db.Text)
    portal_user_id = db.Column(db.Integer, db.ForeignKey("user.id"), unique=True)

    portal_user = db.relationship("User", back_populates="client_profile")
    cases = db.relationship("Case", back_populates="client", lazy="dynamic", cascade="all, delete-orphan")
    invoices = db.relationship("Invoice", back_populates="client", lazy="dynamic")


class Case(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(180), nullable=False, index=True)
    reference_number = db.Column(db.String(60), unique=True, nullable=False, index=True)
    case_type = db.Column(db.String(100))
    description = db.Column(db.Text)
    status = db.Column(db.String(20), nullable=False, default="open", index=True)  # open/pending/closed
    opened_on = db.Column(db.Date, default=date.today, nullable=False)
    closed_on = db.Column(db.Date)
    client_id = db.Column(db.Integer, db.ForeignKey("client.id"), nullable=False, index=True)

    client = db.relationship("Client", back_populates="cases")
    lawyers = db.relationship("User", secondary=case_lawyers, lazy="subquery")
    notes = db.relationship("CaseNote", back_populates="case", lazy="dynamic", cascade="all, delete-orphan")
    documents = db.relationship("Document", back_populates="case", lazy="dynamic", cascade="all, delete-orphan")
    deadlines = db.relationship("Deadline", back_populates="case", lazy="dynamic", cascade="all, delete-orphan")
    tasks = db.relationship("Task", back_populates="case", lazy="dynamic", cascade="all, delete-orphan")
    time_entries = db.relationship("TimeEntry", back_populates="case", lazy="dynamic", cascade="all, delete-orphan")


class CaseNote(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    case_id = db.Column(db.Integer, db.ForeignKey("case.id"), nullable=False, index=True)
    author_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    body = db.Column(db.Text, nullable=False)

    case = db.relationship("Case", back_populates="notes")
    author = db.relationship("User")


class Document(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    case_id = db.Column(db.Integer, db.ForeignKey("case.id"), nullable=False, index=True)
    uploaded_by_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    filename = db.Column(db.String(255), nullable=False)
    original_name = db.Column(db.String(255), nullable=False)
    category = db.Column(db.String(60), index=True)
    description = db.Column(db.String(255))

    case = db.relationship("Case", back_populates="documents")
    uploaded_by = db.relationship("User")


class Deadline(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    case_id = db.Column(db.Integer, db.ForeignKey("case.id"), nullable=False, index=True)
    title = db.Column(db.String(180), nullable=False)
    due_date = db.Column(db.DateTime, nullable=False, index=True)
    kind = db.Column(db.String(50), default="deadline", index=True)  # court_date/deadline
    reminder_sent = db.Column(db.Boolean, default=False, nullable=False)

    case = db.relationship("Case", back_populates="deadlines")


class Task(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    case_id = db.Column(db.Integer, db.ForeignKey("case.id"), nullable=False, index=True)
    title = db.Column(db.String(180), nullable=False)
    details = db.Column(db.Text)
    assignee_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    due_date = db.Column(db.Date)
    status = db.Column(db.String(20), default="todo", nullable=False, index=True)  # todo/in_progress/done

    case = db.relationship("Case", back_populates="tasks")
    assignee = db.relationship("User", back_populates="tasks")


class TimeEntry(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    case_id = db.Column(db.Integer, db.ForeignKey("case.id"), nullable=False, index=True)
    lawyer_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    entry_date = db.Column(db.Date, default=date.today, nullable=False)
    hours = db.Column(db.Float, nullable=False)
    rate = db.Column(db.Float, nullable=False)
    description = db.Column(db.String(255), nullable=False)
    billed = db.Column(db.Boolean, default=False, nullable=False, index=True)

    case = db.relationship("Case", back_populates="time_entries")
    lawyer = db.relationship("User", back_populates="time_entries")


class Invoice(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    invoice_number = db.Column(db.String(60), unique=True, nullable=False, index=True)
    client_id = db.Column(db.Integer, db.ForeignKey("client.id"), nullable=False, index=True)
    issue_date = db.Column(db.Date, default=date.today, nullable=False)
    due_date = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(20), default="draft", nullable=False, index=True)  # draft/sent/paid/partial
    subtotal = db.Column(db.Float, default=0.0, nullable=False)
    tax = db.Column(db.Float, default=0.0, nullable=False)
    total = db.Column(db.Float, default=0.0, nullable=False)

    client = db.relationship("Client", back_populates="invoices")
    items = db.relationship("InvoiceItem", back_populates="invoice", lazy="dynamic", cascade="all, delete-orphan")
    payments = db.relationship("Payment", back_populates="invoice", lazy="dynamic", cascade="all, delete-orphan")


class InvoiceItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    invoice_id = db.Column(db.Integer, db.ForeignKey("invoice.id"), nullable=False, index=True)
    time_entry_id = db.Column(db.Integer, db.ForeignKey("time_entry.id"), index=True)
    description = db.Column(db.String(255), nullable=False)
    quantity = db.Column(db.Float, nullable=False)
    unit_price = db.Column(db.Float, nullable=False)
    line_total = db.Column(db.Float, nullable=False)

    invoice = db.relationship("Invoice", back_populates="items")
    time_entry = db.relationship("TimeEntry")


class Payment(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    invoice_id = db.Column(db.Integer, db.ForeignKey("invoice.id"), nullable=False, index=True)
    amount = db.Column(db.Float, nullable=False)
    payment_date = db.Column(db.Date, default=date.today, nullable=False)
    method = db.Column(db.String(40), nullable=False)
    reference = db.Column(db.String(100))

    invoice = db.relationship("Invoice", back_populates="payments")


class ActivityLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), index=True)
    action = db.Column(db.String(255), nullable=False)
    target = db.Column(db.String(120))
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)

    user = db.relationship("User")


Index("ix_case_status_client", Case.status, Case.client_id)
Index("ix_doc_case_category", Document.case_id, Document.category)
Index("ix_deadline_case_due", Deadline.case_id, Deadline.due_date)
Index("ix_task_case_status", Task.case_id, Task.status)
