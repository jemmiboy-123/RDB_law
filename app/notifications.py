import smtplib
from email.message import EmailMessage

from flask import current_app


def send_email_if_configured(to_email: str, subject: str, body: str) -> bool:
    cfg = current_app.config
    host = cfg.get("SMTP_HOST")
    user = cfg.get("SMTP_USER")
    password = cfg.get("SMTP_PASSWORD")
    if not host or not user or not password:
        return False

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg.get("SMTP_FROM")
    msg["To"] = to_email
    msg.set_content(body)

    with smtplib.SMTP(host, cfg.get("SMTP_PORT", 587), timeout=10) as server:
        server.starttls()
        server.login(user, password)
        server.send_message(msg)
    return True
