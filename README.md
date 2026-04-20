# RDB Law - React + Flask

This project is now split into:

- `app/` Flask backend (auth, RBAC, APIs, database)
- `frontend/` React SPA (Vite)

## Backend (Flask API)

1. Install Python deps:

```bash
pip install -r requirements.txt
```

2. Run backend:

```bash
python run.py
```

Backend runs on `http://localhost:5000`.

## Frontend (React)

1. Open a new terminal and install deps:

```bash
cd frontend
npm install
```

2. Start React dev server:

```bash
npm run dev
```

Frontend runs on `http://localhost:5173` and proxies `/api` to Flask.

## Default Admin Login

- Email: `admin@lawfirm.local`
- Password: `admin12345`

## API Notes

- Session-based auth via Flask-Login
- Main endpoints are under `/api/*`
- Document download endpoint: `/api/documents/<id>/download`

## Optional Production Build

Build React:

```bash
cd frontend
npm run build
```

Then Flask can serve the built app from `/app`.
