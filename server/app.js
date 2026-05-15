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

    CREATE TABLE IF NOT EXISTS activity_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      action_type text NOT NULL,
      summary text NOT NULL,
      schedule_id uuid NULL REFERENCES schedules(id) ON DELETE SET NULL,
      schedule_token text NULL,
      medicine text NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
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

function formatActivityLog(row) {
  return {
    id: row.id,
    actionType: row.action_type,
    summary: row.summary,
    scheduleToken: row.schedule_token,
    medicine: row.medicine,
    details: row.details ?? {},
    createdAt: row.created_at,
  }
}

async function insertActivityLog(
  client,
  { actionType, summary, scheduleId = null, scheduleToken = null, medicine = null, details = {} },
) {
  await client.query(
    `INSERT INTO activity_logs (
       action_type,
       summary,
       schedule_id,
       schedule_token,
       medicine,
       details
     )
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      actionType,
      summary,
      scheduleId,
      scheduleToken,
      medicine,
      JSON.stringify(details),
    ],
  )
}

async function completeIntake(intakeId, completed) {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const intakeResult = await client.query(
      `
        SELECT
          si.id,
          si.schedule_id,
          si.scheduled_at,
          si.completed_at,
          s.token AS schedule_token,
          s.medicine
        FROM schedule_intakes si
        JOIN schedules s ON s.id = si.schedule_id
        WHERE si.id = $1
        LIMIT 1
      `,
      [intakeId],
    )

    if (intakeResult.rowCount === 0) {
      await client.query('ROLLBACK')
      return { status: 404, body: { error: 'Intake not found.' } }
    }

    const intakeRow = intakeResult.rows[0]

    if (completed) {
      const scheduledAt = new Date(intakeRow.scheduled_at)
      const cutoff = new Date()
      cutoff.setHours(0, 0, 0, 0)
      cutoff.setDate(cutoff.getDate() + 5)

      if (scheduledAt >= cutoff) {
        await client.query('ROLLBACK')
        return {
          status: 403,
          body: {
            error: 'This intake is too far in the future to mark complete yet.',
          },
        }
      }
    }

    const completedExpression = completed ? 'CURRENT_TIMESTAMP' : 'NULL'
    const result = await client.query(
      `UPDATE schedule_intakes
       SET completed_at = ${completedExpression}
       WHERE id = $1
       RETURNING *`,
      [intakeId],
    )

    const nextCompletedAt = result.rows[0].completed_at

    await insertActivityLog(client, {
      actionType: completed ? 'intake_completed' : 'intake_reopened',
      summary: completed
        ? `${intakeRow.medicine} marked complete.`
        : `${intakeRow.medicine} reopened.`,
      scheduleId: intakeRow.schedule_id,
      scheduleToken: intakeRow.schedule_token,
      medicine: intakeRow.medicine,
      details: {
        intakeId,
        scheduledAt: intakeRow.scheduled_at,
        completedAt: nextCompletedAt,
      },
    })

    await client.query('COMMIT')

    return {
      status: 200,
      body: {
        intake: {
          id: result.rows[0].id,
          completedAt: result.rows[0].completed_at,
          scheduledAt: result.rows[0].scheduled_at,
        },
      },
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function updateScheduleByToken(token, body) {
  const medicine = String(body?.medicine ?? '').trim()
  const durationDays = Number(body?.durationDays)
  const timesPerDay = Number(body?.timesPerDay)
  const startDate = String(body?.startDate ?? '').trim()

  if (!token) {
    return { status: 400, body: { error: 'Schedule token is required.' } }
  }

  if (!medicine) {
    return { status: 400, body: { error: 'Please provide a medicine name.' } }
  }

  if (!Number.isInteger(durationDays) || durationDays < 1) {
    return { status: 400, body: { error: 'Duration must be at least 1 day.' } }
  }

  if (!Number.isInteger(timesPerDay) || timesPerDay < 1) {
    return {
      status: 400,
      body: { error: 'Times per day must be at least 1.' },
    }
  }

  const normalizedStartDate = startDate || toDateKey(new Date())
  const timeSlots = makeDoseTimes(timesPerDay)
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const scheduleResult = await client.query(
      'SELECT * FROM schedules WHERE token = $1 LIMIT 1',
      [token],
    )

    if (scheduleResult.rowCount === 0) {
      await client.query('ROLLBACK')
      return { status: 404, body: { error: 'Schedule not found.' } }
    }

    const scheduleRow = scheduleResult.rows[0]
    const existingIntakesResult = await client.query(
      'SELECT * FROM schedule_intakes WHERE schedule_id = $1',
      [scheduleRow.id],
    )
    const previousCompletedAtByScheduledAt = new Map(
      existingIntakesResult.rows.map((intake) => [
        new Date(intake.scheduled_at).toISOString(),
        intake.completed_at,
      ]),
    )

    const updatedScheduleResult = await client.query(
      `UPDATE schedules
       SET medicine = $2,
           duration_days = $3,
           times_per_day = $4,
           start_date = $5
       WHERE id = $1
       RETURNING *`,
      [scheduleRow.id, medicine, durationDays, timesPerDay, normalizedStartDate],
    )

    await client.query('DELETE FROM schedule_intakes WHERE schedule_id = $1', [
      scheduleRow.id,
    ])

    const nextIntakeRows = []
    for (let dayIndex = 0; dayIndex < durationDays; dayIndex += 1) {
      const dayDate = new Date(`${normalizedStartDate}T12:00:00`)
      dayDate.setDate(dayDate.getDate() + dayIndex)
      const dayString = toDateKey(dayDate)

      for (let doseIndex = 0; doseIndex < timeSlots.length; doseIndex += 1) {
        const scheduledAt = startOfDayIso(dayString, timeSlots[doseIndex])
        nextIntakeRows.push([
          scheduleRow.id,
          dayIndex,
          doseIndex,
          scheduledAt,
          previousCompletedAtByScheduledAt.get(scheduledAt) ?? null,
        ])
      }
    }

    for (const intakeRow of nextIntakeRows) {
      await client.query(
        `INSERT INTO schedule_intakes (
           schedule_id,
           day_index,
           dose_index,
           scheduled_at,
           completed_at
         )
         VALUES ($1, $2, $3, $4, $5)`,
        intakeRow,
      )
    }

    await insertActivityLog(client, {
      actionType: 'schedule_updated',
      summary: `${medicine} schedule updated.`,
      scheduleId: scheduleRow.id,
      scheduleToken: token,
      medicine,
      details: {
        before: {
          medicine: scheduleRow.medicine,
          durationDays: scheduleRow.duration_days,
          timesPerDay: scheduleRow.times_per_day,
          startDate: toDateKey(scheduleRow.start_date),
        },
        after: {
          medicine,
          durationDays,
          timesPerDay,
          startDate: normalizedStartDate,
        },
      },
    })

    const intakesResult = await client.query(
      'SELECT * FROM schedule_intakes WHERE schedule_id = $1 ORDER BY scheduled_at ASC',
      [scheduleRow.id],
    )

    await client.query('COMMIT')

    return {
      status: 200,
      body: formatSchedule(updatedScheduleResult.rows[0], intakesResult.rows),
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

api.get('/health', async (_request, response) => {
  response.json({
    ok: databaseReady,
    databaseReady,
    error: databaseError instanceof Error ? databaseError.message : null,
  })
})

api.get('/activity-logs', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const requestedLimit = Number(request.query?.limit ?? 8)
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 25)
    : 8

  const result = await pool.query(
    `
      SELECT *
      FROM activity_logs
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit],
  )

  response.json(result.rows.map(formatActivityLog))
})

api.get('/schedules', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const token = String(request.query?.token ?? '').trim()

  if (token) {
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

    await insertActivityLog(client, {
      actionType: 'schedule_created',
      summary: `${medicine} schedule created.`,
      scheduleId: scheduleRow.id,
      scheduleToken: token,
      medicine,
      details: {
        durationDays,
        timesPerDay,
        startDate: normalizedStartDate,
      },
    })

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

  const result = await completeIntake(id, completed)

  response.status(result.status).json(result.body)
})

api.patch('/intakes', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const id = String(request.query?.id ?? '').trim()
  const completed = Boolean(request.body?.completed)

  if (!id) {
    response.status(400).json({ error: 'Intake id is required.' })
    return
  }

  const result = await completeIntake(id, completed)

  response.status(result.status).json(result.body)
})

api.patch('/schedules/:token', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const result = await updateScheduleByToken(request.params.token, request.body)

  response.status(result.status).json(result.body)
})

api.patch('/schedules', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const token = String(request.query?.token ?? '').trim()
  const result = await updateScheduleByToken(token, request.body)

  response.status(result.status).json(result.body)
})

api.delete('/schedules/:token', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const { token } = request.params

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const scheduleResult = await client.query(
      'SELECT * FROM schedules WHERE token = $1 LIMIT 1',
      [token],
    )

    if (scheduleResult.rowCount > 0) {
      const scheduleRow = scheduleResult.rows[0]

      await insertActivityLog(client, {
        actionType: 'schedule_deleted',
        summary: `${scheduleRow.medicine} schedule deleted.`,
        scheduleId: scheduleRow.id,
        scheduleToken: scheduleRow.token,
        medicine: scheduleRow.medicine,
        details: {
          durationDays: scheduleRow.duration_days,
          timesPerDay: scheduleRow.times_per_day,
          startDate: toDateKey(scheduleRow.start_date),
        },
      })
    }

    await client.query(
      'DELETE FROM schedules WHERE token = $1 OR id::text = $1 RETURNING id',
      [token],
    )

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  response.status(204).send()
})

api.delete('/schedules', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const token = String(request.query?.token ?? '').trim()

  if (!token) {
    response.status(400).json({ error: 'Schedule token is required.' })
    return
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const scheduleResult = await client.query(
      'SELECT * FROM schedules WHERE token = $1 LIMIT 1',
      [token],
    )

    if (scheduleResult.rowCount > 0) {
      const scheduleRow = scheduleResult.rows[0]

      await insertActivityLog(client, {
        actionType: 'schedule_deleted',
        summary: `${scheduleRow.medicine} schedule deleted.`,
        scheduleId: scheduleRow.id,
        scheduleToken: scheduleRow.token,
        medicine: scheduleRow.medicine,
        details: {
          durationDays: scheduleRow.duration_days,
          timesPerDay: scheduleRow.times_per_day,
          startDate: toDateKey(scheduleRow.start_date),
        },
      })
    }

    await client.query(
      'DELETE FROM schedules WHERE token = $1 OR id::text = $1 RETURNING id',
      [token],
    )

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  response.status(204).send()
})

export { app }
