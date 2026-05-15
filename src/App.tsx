import { useEffect, useState, type FormEvent } from 'react'
import './App.css'

type Route = { kind: 'home' } | { kind: 'calendar'; token: string }

type ScheduleIntake = {
  id: string
  dayLabel: string
  doseLabel: string
  scheduledAt: string
  completedAt: string | null
}

type ScheduleSummary = {
  id: string
  token: string
  medicine: string
  durationDays: number
  timesPerDay: number
  startDate: string
  createdAt: string
  totalIntakes: number
  completedIntakes: number
}

type ScheduleDetail = ScheduleSummary & {
  intakes: ScheduleIntake[]
}

type ScheduleFormState = {
  medicine: string
  durationDays: string
  timesPerDay: string
  startDate: string
}

type CalendarCell = {
  dateKey: string
  dayNumber: number
  isInSchedule: boolean
  isToday: boolean
  isCurrentMonth: boolean
  items: ScheduleIntake[]
}

const defaultForm: ScheduleFormState = {
  medicine: '',
  durationDays: '7',
  timesPerDay: '3',
  startDate: dateKey(new Date()),
}

const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parseDateOnly(value: string) {
  const normalizedDate = value.includes('T') ? value.slice(0, 10) : value
  return new Date(`${normalizedDate}T12:00:00`)
}

function dateKey(date: Date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

function startOfWeek(date: Date) {
  const next = new Date(date)
  next.setDate(next.getDate() - next.getDay())
  return next
}

function endOfWeek(date: Date) {
  const next = new Date(date)
  next.setDate(next.getDate() + (6 - next.getDay()))
  return next
}

function formatDateLabel(dateValue: string) {
  const date = parseDateOnly(dateValue)

  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatClockLabel(isoValue: string) {
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(isoValue))
}

function formatCompletedTimestamp(isoValue: string) {
  const date = new Date(isoValue)
  const parts = new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date)

  const day = parts.find((part) => part.type === 'day')?.value ?? ''
  const month = parts.find((part) => part.type === 'month')?.value ?? ''
  const hour = parts.find((part) => part.type === 'hour')?.value ?? ''
  const minute = parts.find((part) => part.type === 'minute')?.value ?? ''
  const dayPeriod = parts.find((part) => part.type === 'dayPeriod')?.value ?? ''

  return `${day} ${month}, ${hour}:${minute}${dayPeriod.toLowerCase()}`
}

function getRouteFromLocation(): Route {
  if (typeof window === 'undefined') {
    return { kind: 'home' }
  }

  const match = window.location.pathname.match(/^\/calendar\/([^/]+)$/)

  if (match) {
    return { kind: 'calendar', token: decodeURIComponent(match[1]) }
  }

  return { kind: 'home' }
}

function buildCalendarCells(schedule: ScheduleDetail, monthCursor: Date) {
  const scheduleStart = parseDateOnly(schedule.startDate)
  const scheduleEnd = addDays(scheduleStart, schedule.durationDays - 1)
  const visibleMonthStart = startOfMonth(monthCursor)
  const visibleMonthEnd = endOfMonth(monthCursor)
  const visibleStart = startOfWeek(visibleMonthStart)
  const visibleEnd = endOfWeek(visibleMonthEnd)
  const intakeMap = new Map<string, ScheduleIntake[]>()

  for (const intake of schedule.intakes) {
    const items = intakeMap.get(intake.dayLabel) ?? []
    items.push(intake)
    intakeMap.set(intake.dayLabel, items)
  }

  const weeks: CalendarCell[][] = []
  let cursor = new Date(visibleStart)

  while (cursor <= visibleEnd) {
    const week: CalendarCell[] = []

    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      const current = addDays(cursor, dayOffset)
      const currentKey = dateKey(current)
      const isInSchedule = current >= scheduleStart && current <= scheduleEnd
      const isToday = currentKey === dateKey(new Date())

      week.push({
        dateKey: currentKey,
        dayNumber: current.getDate(),
        isInSchedule,
        isToday,
        isCurrentMonth:
          current.getMonth() === monthCursor.getMonth() &&
          current.getFullYear() === monthCursor.getFullYear(),
        items: intakeMap.get(currentKey) ?? [],
      })
    }

    weeks.push(week)
    cursor = addDays(cursor, 7)
  }

  return {
    monthLabel: new Intl.DateTimeFormat('en', {
      month: 'long',
      year: 'numeric',
    }).format(monthCursor),
    weeks,
  }
}

function isCompletionBlocked(intake: ScheduleIntake) {
  const cutoff = addDays(startOfDay(new Date()), 5)
  return parseDateOnly(intake.scheduledAt) >= cutoff
}

function getScheduleDetailUrl(token: string) {
  if (import.meta.env.DEV) {
    return `/api/schedules/${encodeURIComponent(token)}`
  }

  return `/api/schedules?token=${encodeURIComponent(token)}`
}

function getDeleteScheduleUrl(token: string) {
  if (import.meta.env.DEV) {
    return `/api/schedules/${encodeURIComponent(token)}`
  }

  return `/api/schedules?token=${encodeURIComponent(token)}`
}

function getUpdateIntakeUrl(intakeId: string) {
  if (import.meta.env.DEV) {
    return `/api/intakes/${encodeURIComponent(intakeId)}`
  }

  return `/api/intakes?id=${encodeURIComponent(intakeId)}`
}

function App() {
  const [form, setForm] = useState<ScheduleFormState>(defaultForm)
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([])
  const [selectedSchedule, setSelectedSchedule] = useState<ScheduleDetail | null>(
    null,
  )
  const [route, setRoute] = useState<Route>(() => getRouteFromLocation())
  const [monthCursor, setMonthCursor] = useState<Date>(() =>
    startOfMonth(new Date()),
  )
  const [loadingSchedules, setLoadingSchedules] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('Ready to build your regimen.')

  function navigate(path: string) {
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path)
    }
    setRoute(getRouteFromLocation())
    if (path === '/') {
      setSelectedSchedule(null)
      setError(null)
      setStatus('Ready to build your regimen.')
    }
  }

  useEffect(() => {
    const onPopState = () => setRoute(getRouteFromLocation())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    document.title =
      route.kind === 'calendar'
        ? `Calendar · ${selectedSchedule?.medicine ?? 'Pill Track'}`
        : 'Pill Track'
  }, [route, selectedSchedule])

  useEffect(() => {
    const controller = new AbortController()

    async function loadSchedules() {
      try {
        const response = await fetch('/api/schedules', {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error('We could not load the schedule list.')
        }

        const payload = (await response.json()) as ScheduleSummary[]
        setSchedules(payload)
      } catch (loadError) {
        if ((loadError as Error).name !== 'AbortError') {
          setError((loadError as Error).message)
        }
      } finally {
        setLoadingSchedules(false)
      }
    }

    void loadSchedules()

    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (route.kind !== 'calendar') {
      return
    }

    const token = route.token
    const controller = new AbortController()

    async function loadScheduleDetail() {
      setLoadingDetail(true)
      setError(null)

      try {
        const response = await fetch(getScheduleDetailUrl(token), {
          signal: controller.signal,
        })

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as
            | { error?: string }
            | null
          throw new Error(
            payload?.error ?? 'We could not load that schedule.',
          )
        }

        const payload = (await response.json()) as ScheduleDetail
        setSelectedSchedule(payload)
        setMonthCursor(startOfMonth(parseDateOnly(payload.startDate)))
      } catch (loadError) {
        if ((loadError as Error).name !== 'AbortError') {
          setError((loadError as Error).message)
          setSelectedSchedule(null)
        }
      } finally {
        setLoadingDetail(false)
      }
    }

    void loadScheduleDetail()

    return () => controller.abort()
  }, [route])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)

    try {
      const response = await fetch('/api/schedules', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          medicine: form.medicine.trim(),
          durationDays: Number(form.durationDays),
          timesPerDay: Number(form.timesPerDay),
          startDate: form.startDate,
        }),
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(payload?.error ?? 'We could not save this schedule.')
      }

      const payload = (await response.json()) as ScheduleDetail
      const nextSummary: ScheduleSummary = {
        id: payload.id,
        token: payload.token,
        medicine: payload.medicine,
        durationDays: payload.durationDays,
        timesPerDay: payload.timesPerDay,
        startDate: payload.startDate,
        createdAt: payload.createdAt,
        totalIntakes: payload.totalIntakes,
        completedIntakes: payload.completedIntakes,
      }

      setSchedules((current) => [
        nextSummary,
        ...current.filter((schedule) => schedule.token !== nextSummary.token),
      ])
      setForm(defaultForm)
      setStatus(
        `${nextSummary.medicine} was saved and added to the schedule list.`,
      )
    } catch (submitError) {
      setError((submitError as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function deleteSchedule(scheduleToken: string) {
    const confirmed = window.confirm(
      'Delete this schedule? This will remove the schedule and all of its pill intakes.',
    )

    if (!confirmed) {
      return
    }

    setError(null)
    setStatus('Deleting schedule...')

    try {
      const response = await fetch(getDeleteScheduleUrl(scheduleToken), {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('We could not delete that schedule.')
      }

      setSchedules((current) =>
        current.filter((schedule) => schedule.token !== scheduleToken),
      )

      if (selectedSchedule?.token === scheduleToken) {
        setSelectedSchedule(null)
        navigate('/')
      }

      setStatus('Schedule deleted.')
    } catch (deleteError) {
      setError((deleteError as Error).message)
    }
  }

  async function toggleCompleted(intakeId: string, nextCompleted: boolean) {
    if (!selectedSchedule) {
      return
    }

    const selectedToken = selectedSchedule.token
    const previous = selectedSchedule
    const targetIntake = selectedSchedule.intakes.find(
      (intake) => intake.id === intakeId,
    )
    const wasCompleted = Boolean(targetIntake?.completedAt)

    setStatus('Saving completion state...')

    setSelectedSchedule({
      ...selectedSchedule,
      intakes: selectedSchedule.intakes.map((intake) =>
        intake.id === intakeId
          ? {
              ...intake,
              completedAt: nextCompleted ? new Date().toISOString() : null,
            }
          : intake,
      ),
    })

    try {
      const response = await fetch(getUpdateIntakeUrl(intakeId), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          completed: nextCompleted,
        }),
      })

      if (!response.ok) {
        throw new Error('We could not update that intake.')
      }

      const payload = (await response.json()) as {
        intake: { id: string; completedAt: string | null }
      }

      setSelectedSchedule((current) =>
        current
          ? {
              ...current,
              intakes: current.intakes.map((intake) =>
                intake.id === payload.intake.id
                  ? {
                      ...intake,
                      completedAt: payload.intake.completedAt,
                    }
                  : intake,
              ),
            }
          : current,
      )

      if (nextCompleted !== wasCompleted) {
        setSchedules((current) =>
          current.map((schedule) =>
            schedule.token === selectedToken
              ? {
                  ...schedule,
                  completedIntakes: nextCompleted
                    ? schedule.completedIntakes + 1
                    : Math.max(schedule.completedIntakes - 1, 0),
                }
              : schedule,
          ),
        )
      }

      setStatus(
        nextCompleted ? 'Intake marked complete.' : 'Intake marked as pending.',
      )
    } catch (toggleError) {
      setSelectedSchedule(previous)
      setError((toggleError as Error).message)
    }
  }

  const completedCount =
    selectedSchedule?.intakes.filter((intake) => intake.completedAt).length ?? 0
  const totalCount = selectedSchedule?.intakes.length ?? 0
  const completionPercent =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
  const calendarView =
    selectedSchedule && route.kind === 'calendar'
      ? buildCalendarCells(selectedSchedule, monthCursor)
      : null

  return (
    <main className="app-shell">
      <div className="noise" aria-hidden="true" />
      <section className="panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Pill tracker</p>
            <h1>Medication, without losing the list.</h1>
          </div>
          <p className="topbar-copy">
            Add a schedule, keep the user on the same flow, and let the created
            schedules stack up clearly in one place.
          </p>
        </header>

        {route.kind === 'home' ? (
          <>
            <div className="dashboard-grid">
              <section className="intro-card">
                <p className="section-label">Start here</p>
                <h2>
                  A large, simple form for the medicine the user needs to track.
                </h2>
                <p className="lead">
                  Create a schedule, persist it in Neon, and keep the full list
                  visible so the user can scan every pill plan they have made.
                </p>
                <div className="intake-notes">
                  <div>
                    <span>Saved</span>
                    <strong>Neon PostgreSQL</strong>
                  </div>
                  <div>
                    <span>View</span>
                    <strong>All schedules in one list</strong>
                  </div>
                  <div>
                    <span>Details</span>
                    <strong>Calendar opens on demand</strong>
                  </div>
                </div>
              </section>

              <section className="form-card">
                <form className="pill-form" onSubmit={handleSubmit}>
                  <label>
                    <span>Medicine / Pill</span>
                    <input
                      autoComplete="off"
                      autoFocus
                      name="medicine"
                      placeholder="Amoxicillin"
                      required
                      value={form.medicine}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          medicine: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <label>
                    <span>Duration</span>
                    <input
                      min="1"
                      name="durationDays"
                      type="number"
                      required
                      value={form.durationDays}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          durationDays: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <label>
                    <span>How many times per day</span>
                    <input
                      min="1"
                      max="12"
                      name="timesPerDay"
                      type="number"
                      required
                      value={form.timesPerDay}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          timesPerDay: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <label>
                    <span>Start Date</span>
                    <input
                      name="startDate"
                      type="date"
                      required
                      value={form.startDate}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          startDate: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <button type="submit" disabled={saving}>
                    {saving ? 'Saving...' : 'Submit'}
                  </button>

                  <p className="form-footer">
                    Schedules appear immediately in the list below and stay
                    saved for the next visit.
                  </p>
                </form>
              </section>
            </div>

            <section className="schedule-list-section">
              <div className="section-heading">
                <div>
                  <p className="section-label">Created schedules</p>
                  <h2>All pill plans in one place</h2>
                </div>
                <p className="lead">
                  {schedules.length === 0
                    ? 'No schedules yet. Add the first one above.'
                    : `${schedules.length} schedule${schedules.length === 1 ? '' : 's'} saved.`}
                </p>
              </div>

              {loadingSchedules ? (
                <div className="list-empty">
                  <p>Loading schedules...</p>
                </div>
              ) : schedules.length === 0 ? (
                <div className="list-empty">
                  <p>No schedules have been created yet.</p>
                </div>
              ) : (
                <div className="schedule-grid">
                  {schedules.map((schedule) => (
                    <article className="schedule-card" key={schedule.id}>
                      <div className="schedule-card-top">
                        <div>
                          <p className="schedule-name">{schedule.medicine}</p>
                        </div>
                        <div className="schedule-card-actions">
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() =>
                              navigate(
                                `/calendar/${encodeURIComponent(schedule.token)}`,
                              )
                            }
                          >
                            Open calendar
                          </button>
                          <button
                            className="delete-button"
                            type="button"
                            onClick={() => void deleteSchedule(schedule.token)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>

                      <dl className="schedule-meta-grid">
                        <div>
                          <dt>Duration</dt>
                          <dd>{schedule.durationDays} days</dd>
                        </div>
                        <div>
                          <dt>Per day</dt>
                          <dd>{schedule.timesPerDay} times</dd>
                        </div>
                        <div>
                          <dt>Start date</dt>
                          <dd>{formatDateLabel(schedule.startDate)}</dd>
                        </div>
                        <div>
                          <dt>Created</dt>
                          <dd>{formatDateLabel(schedule.createdAt)}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : (
          <section className="calendar-page">
            <div className="calendar-toolbar">
              <button
                className="back-link"
                type="button"
                onClick={() => navigate('/')}
              >
                Back to Homepage
              </button>

              <div className="calendar-title-block">
                <p className="section-label">Calendar page</p>
                <h2>{selectedSchedule?.medicine ?? 'Schedule calendar'}</h2>
                <p className="lead">
                  {selectedSchedule
                    ? `${selectedSchedule.durationDays} day plan, ${selectedSchedule.timesPerDay} doses per day, starting ${formatDateLabel(selectedSchedule.startDate)}.`
                    : 'Loading the schedule calendar.'}
                </p>
              </div>

              <div className="calendar-header-actions">
                <div className="month-nav">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() =>
                      setMonthCursor(
                        (current) =>
                          new Date(current.getFullYear(), current.getMonth() - 1, 1),
                      )
                    }
                  >
                    Previous
                  </button>
                  <strong>{calendarView?.monthLabel ?? 'Month'}</strong>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() =>
                      setMonthCursor(
                        (current) =>
                          new Date(current.getFullYear(), current.getMonth() + 1, 1),
                      )
                    }
                  >
                    Next
                  </button>
                </div>

                <div className="calendar-summary">
                  <strong>{completionPercent}%</strong>
                  <span>
                    {completedCount} of {totalCount} intakes completed
                  </span>
                  <div className="progress-track" aria-hidden="true">
                    <div
                      className="progress-fill"
                      style={{ width: `${completionPercent}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {loadingDetail ? (
              <div className="list-empty">Loading schedule...</div>
            ) : selectedSchedule && calendarView ? (
              <>
                <div className="calendar-surface">
                  <div className="calendar-weekdays" aria-hidden="true">
                    {weekdayLabels.map((label) => (
                      <div key={label}>{label}</div>
                    ))}
                  </div>

                  <div className="calendar-scroll">
                    <div className="calendar-weeks">
                      {calendarView.weeks.map((week, weekIndex) => (
                        <div className="calendar-week" key={`${weekIndex}`}>
                          {week.map((cell) => (
                            <article
                              key={cell.dateKey}
                              className={[
                                'calendar-cell',
                                cell.isCurrentMonth ? 'current' : 'outside',
                                cell.isInSchedule ? 'in-schedule' : '',
                                cell.isToday ? 'today' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            >
                              <header className="calendar-day-head">
                                <span className="calendar-day-number">
                                  {cell.dayNumber}
                                </span>
                                <span className="calendar-day-weekday">
                                  {weekdayLabels[new Date(`${cell.dateKey}T12:00:00`).getDay()]}
                                </span>
                              </header>

                              <div className="calendar-day-intakes">
                              {cell.items.length === 0 ? (
                                <span className="calendar-empty">No doses</span>
                              ) : (
                                cell.items.map((intake) => {
                                  const completed = Boolean(intake.completedAt)
                                  const blocked = !completed && isCompletionBlocked(intake)

                                  return (
                                    <div key={intake.id} className="intake-item">
                                      <button
                                        className={`intake-chip ${completed ? 'completed' : ''} ${blocked ? 'blocked' : ''}`}
                                        type="button"
                                        aria-pressed={completed}
                                        disabled={blocked}
                                        onClick={() =>
                                          void toggleCompleted(
                                            intake.id,
                                            !completed,
                                          )
                                          }
                                        >
                                          <span
                                            className={`intake-check ${completed ? 'checked' : ''}`}
                                            aria-hidden="true"
                                          >
                                            {completed ? '✓' : '○'}
                                          </span>
                                          <span className="intake-chip-body">
                                            <span className="intake-chip-time">
                                              {formatClockLabel(intake.scheduledAt)}
                                            </span>
                                            <span className="intake-chip-label">
                                              {intake.doseLabel}
                                            </span>
                                          </span>
                                        </button>

                                        {completed && intake.completedAt ? (
                                          <p className="completed-stamp">
                                            Completed{' '}
                                            {formatCompletedTimestamp(
                                              intake.completedAt,
                                            )}
                                          </p>
                                        ) : null}
                                      </div>
                                    )
                                  })
                                )}
                              </div>
                            </article>
                          ))}
                        </div>
                  ))}
                    </div>
                  </div>
                </div>

                <p className="calendar-note">
                  Click the check control on any pill chip to mark it complete
                  or uncheck it later.
                </p>
              </>
            ) : (
              <div className="list-empty">
                <p>{error ?? 'We could not load that schedule.'}</p>
              </div>
            )}
          </section>
        )}

        <footer className="status-bar" aria-live="polite">
          <span>{status}</span>
          {error ? <span className="error-text">{error}</span> : null}
        </footer>
      </section>
    </main>
  )
}

export default App
