# Pill Track

A simple pill tracker app with a large intake form, a generated calendar view, and persisted completion state stored in Neon PostgreSQL.

## Stack

- React + Vite frontend
- Node.js + Express backend
- Neon PostgreSQL for schedule and intake persistence
- Vercel serverless functions for deployment

## Setup

1. Create a Neon database and copy the connection string into `.env` as `DATABASE_URL`.
2. Install dependencies with `npm install`.
3. Start the app with `npm run dev`.

## Scripts

- `npm run dev` starts the Express API on port `3001` and the Vite frontend together.
  The frontend calls the API directly in development, so there is no Vite proxy layer to debug.
- `npm run server` starts only the backend.
- `npm run build` creates the production frontend bundle.
- `npm run lint` runs ESLint.

## Deployment

- Local development still uses `server/index.js` to run Express.
- Vercel uses `api/[[...path]].js` as a serverless wrapper around the same Express app.
- Keep `DATABASE_URL` set in Vercel environment variables so the API can reach Neon.

## Data model

- `schedules` stores the medicine name, duration, frequency, start date, and a shareable token.
- `schedule_intakes` stores each generated intake instance and whether it was completed.

## Persistence flow

- Submitting the form creates a schedule and all intake rows in Neon.
- The frontend stores the returned schedule token in localStorage and in the URL query string.
- Returning to the app restores the saved schedule and all completed states from the database.
# pill-tracker
