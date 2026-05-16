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
app.use(express.json({ limit: '12mb' }))

if (!process.env.VERCEL) {
  app.use((request, response, next) => {
    const origin = request.headers.origin

    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
      response.setHeader('Access-Control-Allow-Credentials', 'true')
    }

    response.setHeader(
      'Access-Control-Allow-Headers',
      request.headers['access-control-request-headers'] ?? 'Content-Type',
    )
    response.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,PATCH,DELETE,OPTIONS',
    )

    if (request.method === 'OPTIONS') {
      response.status(204).end()
      return
    }

    next()
  })
}

const api = express.Router()
app.use('/api', api)

if (process.env.VERCEL) {
  app.use(api)
}

let databaseReady = false
let databaseError = null

function parseTimeToMinutes(timeValue) {
  const [hours, minutes] = String(timeValue ?? '08:00')
    .split(':')
    .map((part) => Number(part))

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return 8 * 60
  }

  return ((hours % 24) * 60 + minutes) % 1440
}

function formatMinutesToTime(totalMinutes) {
  const normalizedMinutes = ((Math.trunc(totalMinutes) % 1440) + 1440) % 1440
  const hours = Math.floor(normalizedMinutes / 60)
  const minutes = normalizedMinutes % 60

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function makePrescribedDoseTimes(timesPerDay, startTime) {
  const count = Math.max(Math.trunc(timesPerDay), 1)
  const interval = Math.floor(1440 / count)
  const startMinutes = parseTimeToMinutes(startTime)

  return Array.from({ length: count }, (_, index) =>
    formatMinutesToTime(startMinutes + interval * index),
  )
}

function makeSupplementDoseTimes() {
  return ['12:00']
}

function makeDoseTimes(timesPerDay, startTime) {
  return makePrescribedDoseTimes(timesPerDay, startTime)
}

function resolveScheduleTiming(scheduleType, timesPerDay, startTime) {
  if (scheduleType === 'supplement') {
    return {
      startTime: null,
      timesPerDay: 1,
      doseTimes: makeSupplementDoseTimes(),
    }
  }

  const resolvedTimesPerDay = Math.max(Math.trunc(timesPerDay) || 0, 1)
  const resolvedStartTime = String(startTime ?? '08:00').trim() || '08:00'

  return {
    startTime: resolvedStartTime,
    timesPerDay: resolvedTimesPerDay,
    doseTimes: makePrescribedDoseTimes(resolvedTimesPerDay, resolvedStartTime),
  }
}

function addDaysToDateKey(dateValue, days) {
  const baseDate = new Date(`${toDateKey(dateValue)}T00:00:00.000Z`)
  baseDate.setUTCDate(baseDate.getUTCDate() + days)
  return baseDate.toISOString().slice(0, 10)
}

function buildIntakeRows({
  scheduleId,
  startDate,
  durationDays,
  doseTimes,
  startTime,
  timezoneOffsetMinutes = 0,
}) {
  const intakeRows = []
  const scheduleStartMinutes =
    typeof startTime === 'string' ? parseTimeToMinutes(startTime) : null

  for (let dayIndex = 0; dayIndex < durationDays; dayIndex += 1) {
    const dayString = addDaysToDateKey(startDate, dayIndex)

    for (let doseIndex = 0; doseIndex < doseTimes.length; doseIndex += 1) {
      const doseTime = doseTimes[doseIndex]
      const doseMinutes = parseTimeToMinutes(doseTime)
      const isOvernightDose =
        scheduleStartMinutes !== null &&
        doseMinutes !== null &&
        doseIndex > 0 &&
        doseMinutes < scheduleStartMinutes
      const scheduledDate = isOvernightDose
        ? addDaysToDateKey(dayString, 1)
        : dayString

      intakeRows.push([
        scheduleId,
        dayIndex,
        doseIndex,
        startOfDayIso(scheduledDate, doseTime, timezoneOffsetMinutes),
      ])
    }
  }

  return intakeRows
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

function startOfDayIso(dateValue, timeValue, timezoneOffsetMinutes = 0) {
  const [year, month, day] = String(dateValue)
    .slice(0, 10)
    .split('-')
    .map(Number)
  const [hour, minute] = timeValue.split(':').map(Number)
  const offset = Number.isFinite(Number(timezoneOffsetMinutes))
    ? Number(timezoneOffsetMinutes)
    : 0
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, 0, 0) + offset * 60_000,
  ).toISOString()
}

async function normalizeLegacyOvernightIntakes() {
  const result = await pool.query(`
    SELECT
      si.id,
      si.schedule_id,
      si.scheduled_at,
      si.day_index,
      si.dose_index,
      s.start_date,
      s.start_time,
      s.times_per_day
    FROM schedule_intakes si
    JOIN schedules s ON s.id = si.schedule_id
    WHERE s.schedule_type = 'prescribed'
      AND si.dose_index > 0
      AND si.scheduled_at IS NOT NULL
    ORDER BY si.schedule_id ASC, si.day_index ASC, si.dose_index ASC
  `)

  const rowsBySchedule = new Map()

  for (const row of result.rows) {
    const scheduleId = row.schedule_id
    const rows = rowsBySchedule.get(scheduleId) ?? []
    rows.push(row)
    rowsBySchedule.set(scheduleId, rows)
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (const rows of rowsBySchedule.values()) {
      const firstRow = rows[0]
      const scheduleStartTime = firstRow.start_time ?? '08:00'
      const startMinutes = parseTimeToMinutes(scheduleStartTime)

      if (startMinutes === null) {
        continue
      }

      const doseTimes = makePrescribedDoseTimes(firstRow.times_per_day, scheduleStartTime)
      const referenceRow = rows.find((row) => row.dose_index === 0) ?? rows[0]
      const referenceDoseTime =
        doseTimes[referenceRow.dose_index] ?? doseTimes[0] ?? scheduleStartTime
      const cycleDay = addDaysToDateKey(firstRow.start_date, referenceRow.day_index)
      const inferredOffsetMinutes = Math.round(
        (new Date(referenceRow.scheduled_at).getTime() -
          new Date(startOfDayIso(cycleDay, referenceDoseTime, 0)).getTime()) /
          60_000,
      )

      for (const row of rows) {
        const doseTime = doseTimes[row.dose_index] ?? doseTimes[0] ?? scheduleStartTime
        const doseMinutes = parseTimeToMinutes(doseTime)

        if (doseMinutes === null) {
          continue
        }

        const baseCycleDay = addDaysToDateKey(firstRow.start_date, row.day_index)
        const intendedDay =
          row.dose_index > 0 && doseMinutes < startMinutes
            ? addDaysToDateKey(baseCycleDay, 1)
            : baseCycleDay
        const expectedScheduledAt = startOfDayIso(
          intendedDay,
          doseTime,
          inferredOffsetMinutes,
        )

        if (new Date(row.scheduled_at).toISOString() !== expectedScheduledAt) {
          await client.query(
            'UPDATE schedule_intakes SET scheduled_at = $2 WHERE id = $1',
            [row.id, expectedScheduledAt],
          )
        }
      }
    }

    await client.query(`
      UPDATE schedule_intakes si
      SET intake_status = 'completed',
          missed_at = NULL
      FROM schedules s
      WHERE s.id = si.schedule_id
        AND s.schedule_type = 'prescribed'
        AND si.completed_at IS NULL
        AND si.intake_status = 'missed'
        AND si.scheduled_at > (CURRENT_TIMESTAMP - INTERVAL '5 hours')
    `)

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function ensureSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS family_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      birthdate date NOT NULL,
      gender text NOT NULL CHECK (gender IN ('male', 'female')),
      avatar_data_url text NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token text NOT NULL UNIQUE,
      medicine text NOT NULL,
      family_member_id uuid NULL REFERENCES family_members(id) ON DELETE SET NULL,
      schedule_type text NOT NULL DEFAULT 'prescribed',
      start_time text NULL,
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
      intake_status text NOT NULL DEFAULT 'pending',
      missed_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (schedule_id, day_index, dose_index)
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      action_type text NOT NULL,
      summary text NOT NULL,
      schedule_id uuid NULL REFERENCES schedules(id) ON DELETE SET NULL,
      schedule_token text NULL,
      family_member_id uuid NULL REFERENCES family_members(id) ON DELETE SET NULL,
      medicine text NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS schedule_intakes_schedule_id_scheduled_at_idx
    ON schedule_intakes (schedule_id, scheduled_at)
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS schedule_intakes_pending_scheduled_at_idx
    ON schedule_intakes (scheduled_at)
    WHERE intake_status = 'pending' AND completed_at IS NULL
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS schedules_created_at_idx
    ON schedules (created_at DESC)
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS activity_logs_created_at_idx
    ON activity_logs (created_at DESC)
  `)

  await pool.query(`
    ALTER TABLE schedules
    ADD COLUMN IF NOT EXISTS schedule_type text NOT NULL DEFAULT 'prescribed'
  `)

  await pool.query(`
    ALTER TABLE schedules
    ADD COLUMN IF NOT EXISTS family_member_id uuid NULL REFERENCES family_members(id) ON DELETE SET NULL
  `)

  await pool.query(`
    ALTER TABLE family_members
    ADD COLUMN IF NOT EXISTS avatar_data_url text NULL
  `)

  await pool.query(`
    ALTER TABLE schedules
    ADD COLUMN IF NOT EXISTS start_time text NULL
  `)

  await pool.query(`
    UPDATE schedules
    SET schedule_type = COALESCE(schedule_type, 'prescribed')
    WHERE schedule_type IS NULL OR schedule_type = ''
  `)

  await pool.query(`
    ALTER TABLE schedules
    ALTER COLUMN schedule_type SET DEFAULT 'prescribed'
  `)

  await pool.query(`
    UPDATE schedules
    SET start_time = COALESCE(start_time, '08:00')
    WHERE schedule_type = 'prescribed' AND (start_time IS NULL OR start_time = '')
  `)

  await pool.query(`
    ALTER TABLE schedule_intakes
    ADD COLUMN IF NOT EXISTS intake_status text NOT NULL DEFAULT 'pending'
  `)

  await pool.query(`
    ALTER TABLE schedule_intakes
    ADD COLUMN IF NOT EXISTS missed_at timestamptz NULL
  `)

  await pool.query(`
    ALTER TABLE activity_logs
    ADD COLUMN IF NOT EXISTS family_member_id uuid NULL REFERENCES family_members(id) ON DELETE SET NULL
  `)

  await pool.query(`
    UPDATE schedule_intakes
    SET intake_status = CASE
      WHEN completed_at IS NOT NULL THEN 'completed'
      ELSE COALESCE(intake_status, 'pending')
    END
  `)

  await normalizeLegacyOvernightIntakes()
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
  const doseTimes =
    (row.schedule_type ?? 'prescribed') === 'supplement'
      ? makeSupplementDoseTimes()
      : makePrescribedDoseTimes(row.times_per_day, row.start_time ?? '08:00')
  const scheduleStartDate = toDateKey(row.start_date)
  const scheduleStartMinutes = parseTimeToMinutes(row.start_time ?? '08:00')

  return {
    id: row.id,
    token: row.token,
    medicine: row.medicine,
    familyMemberId: row.family_member_id ?? null,
    familyMemberName: row.family_member_name ?? null,
    scheduleType: row.schedule_type ?? 'prescribed',
    startTime: row.start_time ?? null,
    durationDays: row.duration_days,
    timesPerDay: row.times_per_day,
    startDate: toDateKey(row.start_date),
    createdAt: row.created_at,
    intakes: intakes.map((intake) => ({
      id: intake.id,
      cycleDayLabel: addDaysToDateKey(scheduleStartDate, intake.day_index),
      doseIndex: intake.dose_index,
      dayLabel: toDateKey(intake.scheduled_at),
      doseTime: doseTimes[intake.dose_index] ?? doseTimes[0] ?? '08:00',
      isOvernight:
        (row.schedule_type ?? 'prescribed') === 'prescribed' &&
        intake.dose_index > 0 &&
        parseTimeToMinutes(
          doseTimes[intake.dose_index] ?? doseTimes[0] ?? '08:00',
        ) < scheduleStartMinutes,
      doseLabel:
        (row.schedule_type ?? 'prescribed') === 'supplement'
          ? 'Daily check-in'
          : `${row.medicine} dose ${intake.dose_index + 1}`,
      scheduledAt: intake.scheduled_at,
      completedAt: intake.completed_at,
      status: intake.completed_at ? 'completed' : (intake.intake_status ?? 'pending'),
      missedAt: intake.missed_at,
    })),
  }
}

function formatScheduleSummary(row) {
  return {
    id: row.id,
    token: row.token,
    medicine: row.medicine,
    familyMemberId: row.family_member_id ?? null,
    familyMemberName: row.family_member_name ?? null,
    scheduleType: row.schedule_type ?? 'prescribed',
    startTime: row.start_time ?? null,
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
    familyMemberId: row.family_member_id ?? null,
    medicine: row.medicine,
    details: row.details ?? {},
    createdAt: row.created_at,
  }
}

function formatFamilyMember(row) {
  return {
    id: row.id,
    name: row.name,
    birthdate: toDateKey(row.birthdate),
    gender: row.gender,
    avatarDataUrl: row.avatar_data_url ?? null,
    createdAt: row.created_at,
  }
}

function normalizeAvatarDataUrl(value) {
  const avatarDataUrl = String(value ?? '').trim()

  if (!avatarDataUrl) {
    return null
  }

  if (!avatarDataUrl.startsWith('data:image/')) {
    return null
  }

  return avatarDataUrl
}

async function sweepMissedIntakes(client) {
  const missedBatches = [
    await client.query(
      `
        WITH overdue AS (
          SELECT
            si.id,
            si.schedule_id,
            si.scheduled_at,
            s.token AS schedule_token,
            s.family_member_id,
            s.medicine
          FROM schedule_intakes si
          JOIN schedules s ON s.id = si.schedule_id
          WHERE s.schedule_type = 'supplement'
            AND si.intake_status = 'pending'
            AND si.completed_at IS NULL
            AND si.scheduled_at::date < CURRENT_DATE
        ),
        updated AS (
          UPDATE schedule_intakes si
          SET intake_status = 'missed',
              missed_at = CURRENT_TIMESTAMP
          FROM overdue
          WHERE si.id = overdue.id
          RETURNING
            si.id,
            si.schedule_id,
            overdue.scheduled_at,
            overdue.schedule_token,
            overdue.family_member_id,
            overdue.medicine
        )
        SELECT * FROM updated
      `,
    ),
    await client.query(
      `
        WITH overdue AS (
          SELECT
            si.id,
            si.schedule_id,
            si.scheduled_at,
            si.dose_index,
            s.token AS schedule_token,
            s.medicine,
            s.start_time,
            s.times_per_day
          FROM schedule_intakes si
          JOIN schedules s ON s.id = si.schedule_id
          WHERE s.schedule_type = 'prescribed'
            AND si.intake_status = 'pending'
            AND si.completed_at IS NULL
            AND si.scheduled_at <= (CURRENT_TIMESTAMP - INTERVAL '5 hours')
        ),
        updated AS (
          UPDATE schedule_intakes si
          SET intake_status = 'missed',
              missed_at = CURRENT_TIMESTAMP
          FROM overdue
          WHERE si.id = overdue.id
          RETURNING
            si.id,
            si.schedule_id,
            overdue.scheduled_at,
            overdue.schedule_token,
            overdue.medicine
        )
        SELECT * FROM updated
      `,
    ),
  ]

  for (const batch of missedBatches) {
    for (const row of batch.rows) {
      await insertActivityLog(client, {
        actionType: 'intake_missed',
        summary: `${row.medicine} dose missed.`,
        scheduleId: row.schedule_id,
        scheduleToken: row.schedule_token,
        familyMemberId: row.family_member_id ?? null,
        medicine: row.medicine,
        details: {
          intakeId: row.id,
          scheduledAt: row.scheduled_at,
        },
      })
    }
  }
}

async function insertActivityLog(
  client,
  {
    actionType,
    summary,
    scheduleId = null,
    scheduleToken = null,
    familyMemberId = null,
    medicine = null,
    details = {},
  },
) {
  await client.query(
    `INSERT INTO activity_logs (
       action_type,
       summary,
       schedule_id,
       schedule_token,
       family_member_id,
       medicine,
       details
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      actionType,
      summary,
      scheduleId,
      scheduleToken,
      familyMemberId,
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
          si.dose_index,
          si.completed_at,
          si.intake_status,
          s.token AS schedule_token,
          s.family_member_id,
          s.medicine,
          s.schedule_type,
          s.start_time,
          s.times_per_day
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
    const scheduledAt = new Date(intakeRow.scheduled_at)
    const scheduledDateKey = toDateKey(intakeRow.scheduled_at)
    const currentDateKey = toDateKey(new Date())
    const isSupplement = intakeRow.schedule_type === 'supplement'
    const cutoff = new Date()
    cutoff.setHours(cutoff.getHours() - 5)
    const hasActuallyMissedWindow =
      (isSupplement && scheduledDateKey < currentDateKey) ||
      (!isSupplement && scheduledAt <= cutoff)

    if (intakeRow.intake_status === 'missed' && !hasActuallyMissedWindow) {
      await client.query(
        `
          UPDATE schedule_intakes
          SET intake_status = 'pending',
              missed_at = NULL
          WHERE id = $1
        `,
        [intakeId],
      )
      intakeRow.intake_status = 'pending'
      intakeRow.missed_at = null
    }

    if (intakeRow.intake_status === 'missed') {
      await client.query('ROLLBACK')
      return {
        status: 409,
        body: {
          error: 'This dose is already marked as Missed Dose.',
        },
      }
    }

    if (completed) {
      if (hasActuallyMissedWindow) {
        const missedResult = await client.query(
          `
            UPDATE schedule_intakes
            SET intake_status = 'missed',
                missed_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
          `,
          [intakeId],
        )
        await insertActivityLog(client, {
          actionType: 'intake_missed',
          summary: `${intakeRow.medicine} dose missed.`,
          scheduleId: intakeRow.schedule_id,
          scheduleToken: intakeRow.schedule_token,
          familyMemberId: intakeRow.family_member_id ?? null,
          medicine: intakeRow.medicine,
          details: {
            intakeId,
            scheduledAt: intakeRow.scheduled_at,
          },
        })
        await client.query('COMMIT')
        return {
          status: 410,
          body: {
            intake: {
              id: missedResult.rows[0].id,
              completedAt: missedResult.rows[0].completed_at,
              scheduledAt: missedResult.rows[0].scheduled_at,
              status: missedResult.rows[0].intake_status,
              missedAt: missedResult.rows[0].missed_at,
            },
            error: 'This dose has passed the allowed completion window and is now Missed Dose.',
          },
        }
      }
    }

    const result = await client.query(
      `UPDATE schedule_intakes
       SET completed_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE NULL END,
           intake_status = CASE WHEN $2 THEN 'completed' ELSE 'pending' END,
           missed_at = NULL
       WHERE id = $1
       RETURNING *`,
      [intakeId, completed],
    )

    const nextCompletedAt = result.rows[0].completed_at

    await insertActivityLog(client, {
      actionType: completed ? 'intake_completed' : 'intake_reopened',
      summary: completed
        ? `${intakeRow.medicine} marked complete.`
        : `${intakeRow.medicine} reopened.`,
      scheduleId: intakeRow.schedule_id,
      scheduleToken: intakeRow.schedule_token,
      familyMemberId: intakeRow.family_member_id ?? null,
      medicine: intakeRow.medicine,
      details: {
        intakeId,
        scheduledAt: intakeRow.scheduled_at,
        completedAt: nextCompletedAt,
        status: completed ? 'completed' : 'pending',
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
          status: result.rows[0].intake_status,
          missedAt: result.rows[0].missed_at,
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

async function createFamilyMember(body) {
  const name = String(body?.name ?? '').trim()
  const birthdate = String(body?.birthdate ?? '').trim()
  const gender = String(body?.gender ?? '').trim() === 'female' ? 'female' : 'male'
  const avatarDataUrl = normalizeAvatarDataUrl(body?.avatarDataUrl)

  if (!name) {
    return { status: 400, body: { error: 'Please provide a family member name.' } }
  }

  if (!birthdate) {
    return { status: 400, body: { error: 'Please provide a birthdate.' } }
  }

  const client = await pool.connect()

  try {
    const result = await client.query(
      `INSERT INTO family_members (name, birthdate, gender, avatar_data_url)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, birthdate, gender, avatarDataUrl],
    )

    return { status: 201, body: formatFamilyMember(result.rows[0]) }
  } finally {
    client.release()
  }
}

async function updateFamilyMemberById(id, body) {
  const memberId = String(id ?? '').trim()
  const name = String(body?.name ?? '').trim()
  const birthdate = String(body?.birthdate ?? '').trim()
  const gender = String(body?.gender ?? '').trim() === 'female' ? 'female' : 'male'
  const avatarDataUrl = normalizeAvatarDataUrl(body?.avatarDataUrl)

  if (!memberId) {
    return { status: 400, body: { error: 'Family member id is required.' } }
  }

  if (!name) {
    return { status: 400, body: { error: 'Please provide a family member name.' } }
  }

  if (!birthdate) {
    return { status: 400, body: { error: 'Please provide a birthdate.' } }
  }

  const client = await pool.connect()

  try {
    const result = await client.query(
      `UPDATE family_members
       SET name = $2,
           birthdate = $3,
           gender = $4,
           avatar_data_url = $5
       WHERE id = $1
       RETURNING *`,
      [memberId, name, birthdate, gender, avatarDataUrl],
    )

    if (result.rowCount === 0) {
      return { status: 404, body: { error: 'Family member not found.' } }
    }

    return { status: 200, body: formatFamilyMember(result.rows[0]) }
  } finally {
    client.release()
  }
}

async function deleteFamilyMemberById(id) {
  const memberId = String(id ?? '').trim()

  if (!memberId) {
    return { status: 400, body: { error: 'Family member id is required.' } }
  }

  const client = await pool.connect()

  try {
    const result = await client.query(
      'DELETE FROM family_members WHERE id = $1 RETURNING *',
      [memberId],
    )

    if (result.rowCount === 0) {
      return { status: 404, body: { error: 'Family member not found.' } }
    }

    return { status: 204, body: null }
  } finally {
    client.release()
  }
}

async function updateScheduleByToken(token, body) {
  const medicine = String(body?.medicine ?? '').trim()
  const familyMemberId = String(body?.familyMemberId ?? '').trim() || null
  const scheduleType =
    String(body?.scheduleType ?? 'prescribed').trim() === 'supplement'
      ? 'supplement'
      : 'prescribed'
  const durationDays = Number(body?.durationDays)
  const timesPerDay = Number(body?.timesPerDay)
  const startDate = String(body?.startDate ?? '').trim()
  const startTime = String(body?.startTime ?? '').trim()
  const timezoneOffsetMinutes = Number(body?.timezoneOffsetMinutes ?? 0)

  if (!token) {
    return { status: 400, body: { error: 'Schedule token is required.' } }
  }

  if (!medicine) {
    return { status: 400, body: { error: 'Please provide a medicine name.' } }
  }

  if (!Number.isInteger(durationDays) || durationDays < 1) {
    return { status: 400, body: { error: 'Duration must be at least 1 day.' } }
  }

  if (scheduleType === 'prescribed' && !Number.isInteger(timesPerDay)) {
    return {
      status: 400,
      body: { error: 'Times per day must be at least 1.' },
    }
  }

  if (familyMemberId) {
    const familyMemberResult = await pool.query(
      'SELECT id FROM family_members WHERE id = $1 LIMIT 1',
      [familyMemberId],
    )

    if (familyMemberResult.rowCount === 0) {
      return { status: 400, body: { error: 'Selected family member was not found.' } }
    }
  }

  const normalizedStartDate = startDate || toDateKey(new Date())
  const timing = resolveScheduleTiming(scheduleType, timesPerDay, startTime)
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
    const currentScheduleType = scheduleRow.schedule_type ?? 'prescribed'
    const currentStartDate = toDateKey(scheduleRow.start_date)
    const currentStartTime = scheduleRow.start_time ?? null
    const currentDurationDays = Number(scheduleRow.duration_days)
    const currentTimesPerDay = Number(scheduleRow.times_per_day)
    const shouldRebuildIntakes =
      currentScheduleType !== scheduleType ||
      currentStartDate !== normalizedStartDate ||
      currentDurationDays !== durationDays ||
      currentTimesPerDay !== timing.timesPerDay ||
      (scheduleType === 'prescribed'
        ? (currentStartTime ?? '08:00') !== timing.startTime
        : currentStartTime !== null)

    const updatedScheduleResult = await client.query(
      `UPDATE schedules
       SET medicine = $2,
           family_member_id = $3,
           schedule_type = $4,
           duration_days = $5,
           times_per_day = $6,
           start_time = $7,
           start_date = $8
       WHERE id = $1
       RETURNING *`,
      [
        scheduleRow.id,
        medicine,
        familyMemberId,
        scheduleType,
        durationDays,
        timing.timesPerDay,
        timing.startTime,
        normalizedStartDate,
      ],
    )

    if (shouldRebuildIntakes) {
      const existingIntakesResult = await client.query(
        `
          SELECT id, day_index, dose_index, scheduled_at, completed_at, intake_status, missed_at
          FROM schedule_intakes
          WHERE schedule_id = $1
        `,
        [scheduleRow.id],
      )
      const existingIntakesByKey = new Map(
        existingIntakesResult.rows.map((intake) => [
          `${intake.day_index}:${intake.dose_index}`,
          intake,
        ]),
      )

      const nextIntakeRows = buildIntakeRows({
        scheduleId: scheduleRow.id,
        startDate: normalizedStartDate,
        durationDays,
        doseTimes: timing.doseTimes,
        startTime: timing.startTime,
        timezoneOffsetMinutes,
      })

      const nextKeys = new Set()

      for (const intakeRow of nextIntakeRows) {
        const [scheduleId, dayIndex, doseIndex, scheduledAt] = intakeRow
        const key = `${dayIndex}:${doseIndex}`
        nextKeys.add(key)

        const existingIntake = existingIntakesByKey.get(key)

        if (existingIntake) {
          if (new Date(existingIntake.scheduled_at).toISOString() !== scheduledAt) {
            await client.query(
              `UPDATE schedule_intakes
               SET scheduled_at = $2
               WHERE id = $1`,
              [existingIntake.id, scheduledAt],
            )
          }

          continue
        }

        await client.query(
          `INSERT INTO schedule_intakes (
             schedule_id,
             day_index,
             dose_index,
             scheduled_at,
             completed_at,
             intake_status,
             missed_at
           )
           VALUES ($1, $2, $3, $4, NULL, 'pending', NULL)`,
          [scheduleId, dayIndex, doseIndex, scheduledAt],
        )
      }

      const obsoleteIntakeIds = existingIntakesResult.rows
        .filter((intake) => !nextKeys.has(`${intake.day_index}:${intake.dose_index}`))
        .map((intake) => intake.id)

      if (obsoleteIntakeIds.length > 0) {
        await client.query(
          'DELETE FROM schedule_intakes WHERE id = ANY($1::uuid[])',
          [obsoleteIntakeIds],
        )
      }

      await client.query(
        `
          UPDATE schedule_intakes
          SET intake_status = 'completed'
          WHERE schedule_id = $1
            AND completed_at IS NOT NULL
            AND intake_status IS DISTINCT FROM 'completed'
        `,
        [scheduleRow.id],
      )
    }

    await insertActivityLog(client, {
      actionType: 'schedule_updated',
      summary: `${medicine} schedule updated.`,
      scheduleId: scheduleRow.id,
      scheduleToken: token,
      familyMemberId,
      medicine,
      details: {
        before: {
          medicine: scheduleRow.medicine,
          familyMemberId: scheduleRow.family_member_id ?? null,
          scheduleType: scheduleRow.schedule_type ?? 'prescribed',
          durationDays: scheduleRow.duration_days,
          timesPerDay: scheduleRow.times_per_day,
          startTime: scheduleRow.start_time ?? null,
          startDate: toDateKey(scheduleRow.start_date),
        },
        after: {
          medicine,
          familyMemberId,
          scheduleType,
          durationDays,
          timesPerDay: timing.timesPerDay,
          startTime: timing.startTime,
          startDate: normalizedStartDate,
        },
        rebuiltIntakes: shouldRebuildIntakes,
      },
    })

    const intakesResult = await client.query(
      'SELECT * FROM schedule_intakes WHERE schedule_id = $1 ORDER BY day_index ASC, dose_index ASC',
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

  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await sweepMissedIntakes(client)

    const requestedLimit = Number(request.query?.limit ?? 5)
    const requestedOffset = Number(request.query?.offset ?? 0)
    const familyMemberId = String(request.query?.familyMemberId ?? '').trim() || null
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 25)
      : 5
    const offset = Number.isFinite(requestedOffset)
      ? Math.max(Math.trunc(requestedOffset), 0)
      : 0

    const whereClause = familyMemberId ? 'WHERE family_member_id = $3' : ''
    const countWhereClause = familyMemberId ? 'WHERE family_member_id = $1' : ''
    const queryValues = familyMemberId
      ? [limit, offset, familyMemberId]
      : [limit, offset]

    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM activity_logs ${countWhereClause}`,
      familyMemberId ? [familyMemberId] : [],
    )
    const result = await client.query(
      `
        SELECT *
        FROM activity_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $1
        OFFSET $2
      `,
      queryValues,
    )

    await client.query('COMMIT')

    response.json({
      items: result.rows.map(formatActivityLog),
      totalCount: Number(countResult.rows[0]?.count ?? 0),
      limit,
      offset,
    })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

api.get('/family-members', async (_request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const result = await pool.query(`
    SELECT *
    FROM family_members
    ORDER BY created_at DESC, name ASC
  `)

  response.json(result.rows.map(formatFamilyMember))
})

api.post('/family-members', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const result = await createFamilyMember(request.body)
  response.status(result.status).json(result.body)
})

api.patch('/family-members/:id', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const result = await updateFamilyMemberById(request.params.id, request.body)
  response.status(result.status).json(result.body)
})

api.delete('/family-members/:id', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const result = await deleteFamilyMemberById(request.params.id)
  if (result.status === 204) {
    response.status(204).send()
    return
  }

  response.status(result.status).json(result.body)
})

api.get('/schedules', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await sweepMissedIntakes(client)

    const token = String(request.query?.token ?? '').trim()

    if (token) {
      const scheduleResult = await client.query(
        `
          SELECT s.*, fm.name AS family_member_name
          FROM schedules s
          LEFT JOIN family_members fm ON fm.id = s.family_member_id
          WHERE s.token = $1
          LIMIT 1
        `,
        [token],
      )

      if (scheduleResult.rowCount === 0) {
        await client.query('ROLLBACK')
        response.status(404).json({ error: 'Schedule not found.' })
        return
      }

      const intakesResult = await client.query(
        'SELECT * FROM schedule_intakes WHERE schedule_id = $1 ORDER BY day_index ASC, dose_index ASC',
        [scheduleResult.rows[0].id],
      )

      await client.query('COMMIT')
      response.json(formatSchedule(scheduleResult.rows[0], intakesResult.rows))
      return
    }

    const result = await client.query(`
      SELECT
        s.*,
        fm.name AS family_member_name,
        COUNT(si.id) AS total_intakes,
        COUNT(si.completed_at) AS completed_intakes
      FROM schedules s
      LEFT JOIN schedule_intakes si ON si.schedule_id = s.id
      LEFT JOIN family_members fm ON fm.id = s.family_member_id
      GROUP BY s.id, fm.name
      ORDER BY s.created_at DESC
    `)

    await client.query('COMMIT')
    response.json(result.rows.map(formatScheduleSummary))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

api.get('/schedules/:token', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await sweepMissedIntakes(client)

    const { token } = request.params

    const scheduleResult = await client.query(
      `
        SELECT s.*, fm.name AS family_member_name
        FROM schedules s
        LEFT JOIN family_members fm ON fm.id = s.family_member_id
        WHERE s.token = $1
        LIMIT 1
      `,
      [token],
    )

    if (scheduleResult.rowCount === 0) {
      await client.query('ROLLBACK')
      response.status(404).json({ error: 'Schedule not found.' })
      return
    }

    const intakesResult = await client.query(
      'SELECT * FROM schedule_intakes WHERE schedule_id = $1 ORDER BY day_index ASC, dose_index ASC',
      [scheduleResult.rows[0].id],
    )

    await client.query('COMMIT')
    response.json(formatSchedule(scheduleResult.rows[0], intakesResult.rows))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

api.post('/schedules', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const medicine = String(request.body?.medicine ?? '').trim()
  const familyMemberId = String(request.body?.familyMemberId ?? '').trim() || null
  const scheduleType =
    String(request.body?.scheduleType ?? 'prescribed').trim() === 'supplement'
      ? 'supplement'
      : 'prescribed'
  const durationDays = Number(request.body?.durationDays)
  const timesPerDay = Number(request.body?.timesPerDay)
  const startDate = String(request.body?.startDate ?? '').trim()
  const startTime = String(request.body?.startTime ?? '').trim()
  const timezoneOffsetMinutes = Number(request.body?.timezoneOffsetMinutes ?? 0)

  if (!medicine) {
    response.status(400).json({ error: 'Please provide a medicine name.' })
    return
  }

  if (!Number.isInteger(durationDays) || durationDays < 1) {
    response.status(400).json({ error: 'Duration must be at least 1 day.' })
    return
  }

  if (scheduleType === 'prescribed' && (!Number.isInteger(timesPerDay) || timesPerDay < 1)) {
    response.status(400).json({ error: 'Times per day must be at least 1.' })
    return
  }

  if (familyMemberId) {
    const familyMemberResult = await pool.query(
      'SELECT id FROM family_members WHERE id = $1 LIMIT 1',
      [familyMemberId],
    )

    if (familyMemberResult.rowCount === 0) {
      response.status(400).json({ error: 'Selected family member was not found.' })
      return
    }
  }

  const normalizedStartDate = startDate || toDateKey(new Date())
  const timing = resolveScheduleTiming(scheduleType, timesPerDay, startTime)
  const token = crypto.randomUUID().slice(0, 12)

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const scheduleInsert = await client.query(
      `INSERT INTO schedules (token, medicine, family_member_id, schedule_type, duration_days, times_per_day, start_time, start_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        token,
        medicine,
        familyMemberId,
        scheduleType,
        durationDays,
        timing.timesPerDay,
        timing.startTime,
        normalizedStartDate,
      ],
    )

    const scheduleRow = scheduleInsert.rows[0]
    const intakeRows = buildIntakeRows({
      scheduleId: scheduleRow.id,
      startDate: normalizedStartDate,
      durationDays,
      doseTimes: timing.doseTimes,
      startTime: timing.startTime,
      timezoneOffsetMinutes,
    })

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
      familyMemberId,
      medicine,
      details: {
        scheduleType,
        familyMemberId,
        durationDays,
        timesPerDay: timing.timesPerDay,
        startTime: timing.startTime,
        startDate: normalizedStartDate,
        doseTimes: timing.doseTimes,
      },
    })

    const detailResult = await client.query(
      `
        SELECT s.*, fm.name AS family_member_name
        FROM schedules s
        LEFT JOIN family_members fm ON fm.id = s.family_member_id
        WHERE s.id = $1
        LIMIT 1
      `,
      [scheduleRow.id],
    )

    const intakesResult = await client.query(
      'SELECT * FROM schedule_intakes WHERE schedule_id = $1 ORDER BY day_index ASC, dose_index ASC',
      [scheduleRow.id],
    )

    await client.query('COMMIT')

    response.status(201).json(formatSchedule(detailResult.rows[0], intakesResult.rows))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

api.get('/schedules/:token', async (request, response) => {
  if (!databaseReady) {
    unavailableResponse(response)
    return
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await sweepMissedIntakes(client)

    const { token } = request.params

    const scheduleResult = await client.query(
      'SELECT * FROM schedules WHERE token = $1 LIMIT 1',
      [token],
    )

    if (scheduleResult.rowCount === 0) {
      await client.query('ROLLBACK')
      response.status(404).json({ error: 'Schedule not found.' })
      return
    }

    const intakesResult = await client.query(
      'SELECT * FROM schedule_intakes WHERE schedule_id = $1 ORDER BY day_index ASC, dose_index ASC',
      [scheduleResult.rows[0].id],
    )

    await client.query('COMMIT')
    response.json(formatSchedule(scheduleResult.rows[0], intakesResult.rows))
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
        familyMemberId: scheduleRow.family_member_id ?? null,
        medicine: scheduleRow.medicine,
        details: {
          durationDays: scheduleRow.duration_days,
          timesPerDay: scheduleRow.times_per_day,
          startTime: scheduleRow.start_time ?? null,
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
          startTime: scheduleRow.start_time ?? null,
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
