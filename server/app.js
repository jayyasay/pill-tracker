import 'dotenv/config'
import crypto from 'node:crypto'

import express from 'express'
import { Pool } from 'pg'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Use your Neon PostgreSQL connection string.')
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('localhost')
    ? false
    : {
        rejectUnauthorized: false,
      },
})

const app = express()
app.use(express.json())
const api = express.Router()
app.use('/api', api)

if (process.env.VERCEL) {
  app.use(api)
}

let databaseReady = false
let databaseError = null

function makeDoseTimes(timesPerDay) {
  if (timesPerDay <= 1) {
    return ['08:00']
  }

  if (timesPerDay === 2) {
    return ['08:00', '20:00']
  }

  if (timesPerDay === 3) {
    return ['08:00', '14:00', '20:00']
  }

  if (timesPerDay === 4) {
    return ['08:00', '12:00', '16:00', '20:00']
  }

  const startMinutes = 6 * 60
  const interval = Math.floor((16 * 60) / Math.max(timesPerDay - 1, 1))

  return Array.from({ length: timesPerDay }, (_, index) => {
    const totalMinutes = startMinutes + interval * index
    const hours = Math.floor(totalMinutes / 60) % 24
    const minutes = totalMinutes % 60
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  })
}

function toDateKey(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10)
  }

  const date = new Date(value)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function startOfDayIso(dateValue, timeValue) {
  const [year, month, day] = dateValue.split('-').map(Number)
  const [hour, minute] = timeValue.split(':').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString()
}

async function ensureSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS schedules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token text NOT NULL UNIQUE,
      medicine text NOT NULL,
      duration_days integer NOT NULL CHECK (duration_days > 0),
      times_per_day integer NOT NULL CHECK (times_per_day > 0),
      start_date date NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS schedule_intakes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      day_index integer NOT NULL,
      dose_index integer NOT NULL,
      scheduled_at timestamptz NOT NULL,
      completed_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (schedule_id, day_index, dose_index)
    );
  `)
}

export async function initializeDatabase() {
  try {
    await ensureSchema()
    databaseReady = true
    databaseError = null
  } catch (error) {
    databaseReady = false
    databaseError = error
    console.warn(
      'Database is unavailable. API will return 503 until Neon is reachable.',
      error instanceof Error ? error.message : error,
    )
  }
}

function unavailableResponse(response) {
  response.status(503).json({
    error:
      'Database is unavailable. Check DATABASE_URL and Neon connectivity, then reload.',
    detail: databaseError instanceof Error ? databaseError.message : null,
  })
}

function formatSchedule(row, intakes) {
  return {
    id: row.id,
    token: row.token,
    medicine: row.medicine,
    durationDays: row.duration_days,
    timesPerDay: row.times_per_day,
    startDate: toDateKey(row.start_date),
    createdAt: row.created_at,
    intakes: intakes.map((intake) => ({
      id: intake.id,
      dayLabel: toDateKey(intake.scheduled_at),
      doseLabel: `${row.medicine} dose ${intake.dose_index + 1}`,
      scheduledAt: intake.scheduled_at,
      completedAt: intake.completed_at,
    })),
  }
}

function formatScheduleSummary(row) {
  return {
    id: row.id,
    token: row.token,
    medicine: row.medicine,
    durationDays: row.duration_days,
    timesPerDay: row.times_per_day,
    startDate: toDateKey(row.start_date),
    createdAt: row.created_at,
    totalIntakes: Number(row.total_intakes ?? 0),
    completedIntakes: Number(row.completed_intakes ?? 0),
  }
}

api.get('/health', async (_request, response) => {
  response.json({
    ok: databaseReady,
    databaseReady,
    error: databaseError instanceof Error ? databaseError.message : null,
  })
})

api.get('/schedules/:token', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const { token } = request.params

  const scheduleResult = await pool.query(
    'SELECT * FROM schedules WHERE token = $1 LIMIT 1',
    [token],
  )

  if (scheduleResult.rowCount === 0) {
    response.status(404).json({ error: 'Schedule not found.' })
    return
  }

  const intakesResult = await pool.query(
    'SELECT * FROM schedule_intakes WHERE schedule_id = $1 ORDER BY scheduled_at ASC',
    [scheduleResult.rows[0].id],
  )

  response.json(formatSchedule(scheduleResult.rows[0], intakesResult.rows))
})

api.get('/schedules', async (_request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const result = await pool.query(`
    SELECT
      s.*,
      COUNT(si.id) AS total_intakes,
      COUNT(si.completed_at) AS completed_intakes
    FROM schedules s
    LEFT JOIN schedule_intakes si ON si.schedule_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `)

  response.json(result.rows.map(formatScheduleSummary))
})

api.post('/schedules', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const medicine = String(request.body?.medicine ?? '').trim()
  const durationDays = Number(request.body?.durationDays)
  const timesPerDay = Number(request.body?.timesPerDay)
  const startDate = String(request.body?.startDate ?? '').trim()

  if (!medicine) {
    response.status(400).json({ error: 'Please provide a medicine name.' })
    return
  }

  if (!Number.isInteger(durationDays) || durationDays < 1) {
    response.status(400).json({ error: 'Duration must be at least 1 day.' })
    return
  }

  if (!Number.isInteger(timesPerDay) || timesPerDay < 1) {
    response.status(400).json({ error: 'Times per day must be at least 1.' })
    return
  }

  const normalizedStartDate = startDate || toDateKey(new Date())
  const timeSlots = makeDoseTimes(timesPerDay)
  const token = crypto.randomUUID().slice(0, 12)

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const scheduleInsert = await client.query(
      `INSERT INTO schedules (token, medicine, duration_days, times_per_day, start_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [token, medicine, durationDays, timesPerDay, normalizedStartDate],
    )

    const scheduleRow = scheduleInsert.rows[0]

    const intakeRows = []
    for (let dayIndex = 0; dayIndex < durationDays; dayIndex += 1) {
      const dayDate = new Date(`${normalizedStartDate}T12:00:00`)
      dayDate.setDate(dayDate.getDate() + dayIndex)
      const dayString = toDateKey(dayDate)

      for (let doseIndex = 0; doseIndex < timeSlots.length; doseIndex += 1) {
        intakeRows.push([
          scheduleRow.id,
          dayIndex,
          doseIndex,
          startOfDayIso(dayString, timeSlots[doseIndex]),
        ])
      }
    }

    for (const intakeRow of intakeRows) {
      await client.query(
        `INSERT INTO schedule_intakes (schedule_id, day_index, dose_index, scheduled_at)
         VALUES ($1, $2, $3, $4)`,
        intakeRow,
      )
    }

    const intakesResult = await client.query(
      'SELECT * FROM schedule_intakes WHERE schedule_id = $1 ORDER BY scheduled_at ASC',
      [scheduleRow.id],
    )

    await client.query('COMMIT')

    response.status(201).json(formatSchedule(scheduleRow, intakesResult.rows))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

api.patch('/intakes/:id', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const { id } = request.params
  const completed = Boolean(request.body?.completed)

  if (completed) {
    const intakeResult = await pool.query(
      'SELECT scheduled_at, completed_at FROM schedule_intakes WHERE id = $1 LIMIT 1',
      [id],
    )

    if (intakeResult.rowCount === 0) {
      response.status(404).json({ error: 'Intake not found.' })
      return
    }

    const scheduledAt = new Date(intakeResult.rows[0].scheduled_at)
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() + 5)

    if (scheduledAt >= cutoff) {
      response.status(403).json({
        error:
          'This intake is too far in the future to mark complete yet.',
      })
      return
    }
  }

  const completedExpression = completed ? 'CURRENT_TIMESTAMP' : 'NULL'

  const result = await pool.query(
    `UPDATE schedule_intakes
     SET completed_at = ${completedExpression}
     WHERE id = $1
     RETURNING *`,
    [id],
  )

  if (result.rowCount === 0) {
    response.status(404).json({ error: 'Intake not found.' })
    return
  }

  response.json({
    intake: {
      id: result.rows[0].id,
      completedAt: result.rows[0].completed_at,
      scheduledAt: result.rows[0].scheduled_at,
    },
  })
})

api.delete('/schedules/:token', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const { token } = request.params

  await pool.query(
    'DELETE FROM schedules WHERE token = $1 OR id::text = $1 RETURNING id',
    [token],
  )

  // Keep DELETE idempotent so repeated deletes do not surface as client errors.
  response.status(204).send()
})

export { app }
