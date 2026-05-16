import {
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import AppBar from "@mui/material/AppBar";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Menu from "@mui/material/Menu";
import Toolbar from "@mui/material/Toolbar";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import "./App.css";
import Badge from "@mui/material/Badge";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";

type Route =
  | { kind: "home" }
  | { kind: "family" }
  | { kind: "calendar"; token: string };

type ScheduleIntake = {
  id: string;
  cycleDayLabel: string;
  dayLabel: string;
  doseIndex: number;
  doseTime: string;
  doseLabel: string;
  scheduledAt: string;
  completedAt: string | null;
  status: "pending" | "completed" | "missed";
  missedAt: string | null;
  isOvernight: boolean;
};

type ScheduleSummary = {
  id: string;
  token: string;
  medicine: string;
  familyMemberId: string | null;
  familyMemberName: string | null;
  scheduleType: "prescribed" | "supplement";
  durationDays: number;
  timesPerDay: number;
  startTime: string | null;
  startDate: string;
  createdAt: string;
  totalIntakes: number;
  completedIntakes: number;
};

type ScheduleDetail = ScheduleSummary & {
  intakes: ScheduleIntake[];
};

type ActivityLogEntry = {
  id: string;
  actionType: string;
  summary: string;
  familyMemberId: string | null;
  scheduleToken: string | null;
  medicine: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

type ActivityLogResponse = {
  items: ActivityLogEntry[];
  totalCount: number;
  limit: number;
  offset: number;
};

type FamilyMember = {
  id: string;
  name: string;
  birthdate: string;
  gender: "male" | "female";
  avatarDataUrl: string | null;
  createdAt: string;
};

type ScheduleFormState = {
  medicine: string;
  familyMemberId: string;
  scheduleType: "prescribed" | "supplement";
  durationDays: string;
  timesPerDay: string;
  startTime: string;
  startDate: string;
};

type FamilyFormState = {
  name: string;
  birthdate: string;
  gender: "male" | "female";
  avatarDataUrl: string | null;
};

type CalendarCell = {
  dateKey: string;
  dayNumber: number;
  isInSchedule: boolean;
  isToday: boolean;
  isCurrentMonth: boolean;
  items: ScheduleIntake[];
};

const defaultForm: ScheduleFormState = {
  medicine: "",
  familyMemberId: "",
  scheduleType: "prescribed",
  durationDays: "7",
  timesPerDay: "3",
  startTime: "08:00",
  startDate: dateKey(new Date()),
};

const defaultFamilyForm: FamilyFormState = {
  name: "",
  birthdate: "",
  gender: "male",
  avatarDataUrl: null,
};

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const activityLogPageSize = 5;

function parseDateOnly(value: string) {
  const normalizedDate = value.includes("T") ? value.slice(0, 10) : value;
  return new Date(`${normalizedDate}T12:00:00`);
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function startOfWeek(date: Date) {
  const next = new Date(date);
  next.setDate(next.getDate() - next.getDay());
  return next;
}

function endOfWeek(date: Date) {
  const next = new Date(date);
  next.setDate(next.getDate() + (6 - next.getDay()));
  return next;
}

function formatDateLabel(dateValue: string) {
  const date = parseDateOnly(dateValue);

  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatTimeInputLabel(timeValue?: string | null) {
  if (!timeValue) {
    return "";
  }

  const [hours, minutes] = timeValue.split(":").map((part) => Number(part));

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return timeValue;
  }

  const date = new Date(2000, 0, 1, hours, minutes, 0, 0);
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function parseTimeInputToMinutes(timeValue?: string | null) {
  if (!timeValue) {
    return null;
  }

  const [hours, minutes] = timeValue.split(":").map((part) => Number(part));

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }

  return ((hours % 24) * 60 + minutes) % 1440;
}

function getPrescribedDoseTimes(timesPerDay: number, startTime: string) {
  const count = Math.max(Math.trunc(timesPerDay) || 0, 1);
  const [hours, minutes] = startTime.split(":").map((part) => Number(part));
  const startMinutes =
    Number.isInteger(hours) && Number.isInteger(minutes)
      ? ((hours % 24) * 60 + minutes) % 1440
      : 8 * 60;
  const interval = Math.floor(1440 / count);

  return Array.from({ length: count }, (_, index) => {
    const totalMinutes = (startMinutes + interval * index) % 1440;
    const nextHours = Math.floor(totalMinutes / 60);
    const nextMinutes = totalMinutes % 60;
    const time = new Date(2000, 0, 1, nextHours, nextMinutes, 0, 0);
    return new Intl.DateTimeFormat("en", {
      hour: "numeric",
      minute: "2-digit",
    }).format(time);
  });
}

function formatCompletedTimestamp(isoValue: string) {
  const date = new Date(isoValue);
  const parts = new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);

  const day = parts.find((part) => part.type === "day")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  const dayPeriod =
    parts.find((part) => part.type === "dayPeriod")?.value ?? "";

  return `${day} ${month}, ${hour}:${minute}${dayPeriod.toLowerCase()}`;
}

function formatBirthdateLabel(dateValue: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parseDateOnly(dateValue));
}

function formatActivityTimestamp(isoValue: string) {
  return formatCompletedTimestamp(isoValue);
}

function getActivityLabel(actionType: string) {
  switch (actionType) {
    case "schedule_created":
      return "Created";
    case "schedule_updated":
      return "Updated";
    case "schedule_deleted":
      return "Deleted";
    case "intake_completed":
      return "Completed";
    case "intake_reopened":
      return "Reopened";
    case "intake_missed":
      return "Missed";
    default:
      return "Activity";
  }
}

function getScheduleTypeLabel(scheduleType: "prescribed" | "supplement") {
  return scheduleType === "supplement"
    ? "Supplement / Vitamins"
    : "Prescribed Medication";
}

function getScheduleSectionCopy(scheduleType: "prescribed" | "supplement") {
  return scheduleType === "supplement"
    ? "Daily supplement tracking"
    : "Doctor-prescribed intake tracking";
}

function getGenderLabel(gender: "male" | "female") {
  return gender === "female" ? "Female" : "Male";
}

function getInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function readImageFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result);
    };

    reader.onerror = () => {
      reject(new Error("We could not read that image."));
    };

    reader.readAsDataURL(file);
  });
}

async function readAvatarThumbnailAsDataUrl(file: File) {
  const sourceDataUrl = await readImageFileAsDataUrl(file);

  if (typeof window === "undefined") {
    return sourceDataUrl;
  }

  const image = new Image();
  image.src = sourceDataUrl;
  await image.decode().catch(() => null);

  const maxSide = 320;
  const scale = Math.min(
    1,
    maxSide / Math.max(image.width || maxSide, image.height || maxSide),
  );
  const width = Math.max(1, Math.round((image.width || maxSide) * scale));
  const height = Math.max(1, Math.round((image.height || maxSide) * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (!context) {
    return sourceDataUrl;
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  return canvas.toDataURL("image/jpeg", 0.85);
}

function getRouteFromLocation(): Route {
  if (typeof window === "undefined") {
    return { kind: "home" };
  }

  if (window.location.pathname === "/family") {
    return { kind: "family" };
  }

  const match = window.location.pathname.match(/^\/calendar\/([^/]+)$/);

  if (match) {
    return { kind: "calendar", token: decodeURIComponent(match[1]) };
  }

  return { kind: "home" };
}

function buildCalendarCells(schedule: ScheduleDetail, monthCursor: Date) {
  const scheduleStart = parseDateOnly(schedule.startDate);
  const scheduleEnd = addDays(scheduleStart, schedule.durationDays - 1);
  const visibleMonthStart = startOfMonth(monthCursor);
  const visibleMonthEnd = endOfMonth(monthCursor);
  const visibleStart = startOfWeek(visibleMonthStart);
  const visibleEnd = endOfWeek(visibleMonthEnd);
  const intakeMap = new Map<string, ScheduleIntake[]>();

  for (const intake of schedule.intakes) {
    const items = intakeMap.get(intake.cycleDayLabel ?? intake.dayLabel) ?? [];
    items.push(intake);
    intakeMap.set(intake.cycleDayLabel ?? intake.dayLabel, items);
  }

  const weeks: CalendarCell[][] = [];
  let cursor = new Date(visibleStart);

  while (cursor <= visibleEnd) {
    const week: CalendarCell[] = [];

    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      const current = addDays(cursor, dayOffset);
      const currentKey = dateKey(current);
      const isInSchedule = current >= scheduleStart && current <= scheduleEnd;
      const isToday = currentKey === dateKey(new Date());

      week.push({
        dateKey: currentKey,
        dayNumber: current.getDate(),
        isInSchedule,
        isToday,
        isCurrentMonth:
          current.getMonth() === monthCursor.getMonth() &&
          current.getFullYear() === monthCursor.getFullYear(),
        items: intakeMap.get(currentKey) ?? [],
      });
    }

    weeks.push(week);
    cursor = addDays(cursor, 7);
  }

  return {
    monthLabel: new Intl.DateTimeFormat("en", {
      month: "long",
      year: "numeric",
    }).format(monthCursor),
    weeks,
  };
}

function isMissedDose(
  schedule: ScheduleSummary | ScheduleDetail,
  intake: ScheduleIntake,
) {
  if (intake.status === "completed") {
    return false;
  }

  if (schedule.scheduleType === "supplement") {
    return dateKey(parseDateOnly(intake.scheduledAt)) < dateKey(new Date());
  }

  const cutoff = Date.now() - 5 * 60 * 60 * 1000;
  return new Date(intake.scheduledAt).getTime() <= cutoff;
}

function getIntakeTimeLabel(
  schedule: ScheduleSummary | ScheduleDetail,
  intake: ScheduleIntake,
) {
  if (schedule.scheduleType === "supplement") {
    return "Anytime today";
  }

  const doseTimes = getPrescribedDoseTimes(
    schedule.timesPerDay,
    schedule.startTime ?? "08:00",
  );
  const doseTime =
    intake.doseTime ?? doseTimes[intake.doseIndex] ?? schedule.startTime;
  const label = formatTimeInputLabel(doseTime) || "08:00 AM";
  const startMinutes = parseTimeInputToMinutes(schedule.startTime ?? "08:00");
  const doseMinutes = parseTimeInputToMinutes(doseTime);

  if (
    intake.isOvernight ||
    (startMinutes !== null &&
      doseMinutes !== null &&
      intake.doseIndex > 0 &&
      doseMinutes < startMinutes)
  ) {
    return `${label} next day`;
  }

  return label;
}

function getScheduleDetailUrl(token: string) {
  return apiUrl(`/api/schedules/${encodeURIComponent(token)}`);
}

function getDeleteScheduleUrl(token: string) {
  return apiUrl(`/api/schedules/${encodeURIComponent(token)}`);
}

function getUpdateScheduleUrl(token: string) {
  return apiUrl(`/api/schedules/${encodeURIComponent(token)}`);
}

function getUpdateIntakeUrl(intakeId: string) {
  return apiUrl(`/api/intakes/${encodeURIComponent(intakeId)}`);
}

function getActivityLogUrl() {
  return apiUrl("/api/activity-logs");
}

function getFamilyMembersUrl() {
  return apiUrl("/api/family-members");
}

function getFamilyMemberUpdateUrl(id: string) {
  return apiUrl(`/api/family-members/${encodeURIComponent(id)}`);
}

function getFamilyMemberDeleteUrl(id: string) {
  return apiUrl(`/api/family-members/${encodeURIComponent(id)}`);
}

function apiUrl(path: string) {
  return import.meta.env.DEV ? `http://localhost:3001${path}` : path;
}

function App() {
  const [form, setForm] = useState<ScheduleFormState>(defaultForm);
  const [familyForm, setFamilyForm] =
    useState<FamilyFormState>(defaultFamilyForm);
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([]);
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLogEntry[]>([]);
  const [activityLogPage, setActivityLogPage] = useState(0);
  const [activityLogTotalCount, setActivityLogTotalCount] = useState(0);
  const [selectedFamilyMemberId, setSelectedFamilyMemberId] = useState<
    string | null
  >(null);
  const [selectedSchedule, setSelectedSchedule] =
    useState<ScheduleDetail | null>(null);
  const [route, setRoute] = useState<Route>(() => getRouteFromLocation());
  const [monthCursor, setMonthCursor] = useState<Date>(() =>
    startOfMonth(new Date()),
  );
  const [isMedicationModalOpen, setIsMedicationModalOpen] = useState(false);
  const [loadingSchedules, setLoadingSchedules] = useState(true);
  const [loadingFamilyMembers, setLoadingFamilyMembers] = useState(true);
  const [loadingActivityLogs, setLoadingActivityLogs] = useState(true);
  const [loadingActivityPage, setLoadingActivityPage] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingFamilyMember, setSavingFamilyMember] = useState(false);
  const [isFamilyDrawerOpen, setIsFamilyDrawerOpen] = useState(false);
  const [editingScheduleToken, setEditingScheduleToken] = useState<
    string | null
  >(null);
  const [editingFamilyMemberId, setEditingFamilyMemberId] = useState<
    string | null
  >(null);
  const [navAnchorEl, setNavAnchorEl] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Ready to build your regimen.");
  const theme = useTheme();
  const isCompactNav = useMediaQuery(theme.breakpoints.down("md"));

  function navigate(path: string) {
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    setRoute(getRouteFromLocation());
    setNavAnchorEl(null);
    setIsMedicationModalOpen(false);
    setIsFamilyDrawerOpen(false);
    if (path === "/") {
      setSelectedSchedule(null);
      setEditingScheduleToken(null);
      setEditingFamilyMemberId(null);
      setError(null);
      setStatus("Ready to build your regimen.");
    } else if (path === "/family") {
      setSelectedSchedule(null);
      setEditingScheduleToken(null);
      setEditingFamilyMemberId(null);
      setError(null);
      setStatus("Viewing family members.");
    }
  }

  function openNavMenu(event: MouseEvent<HTMLButtonElement>) {
    setNavAnchorEl(event.currentTarget);
  }

  function closeNavMenu() {
    setNavAnchorEl(null);
  }

  function openFamilyDrawer(member?: FamilyMember | null) {
    if (member) {
      setEditingFamilyMemberId(member.id);
      setFamilyForm({
        name: member.name,
        birthdate: member.birthdate,
        gender: member.gender,
        avatarDataUrl: member.avatarDataUrl,
      });
    } else {
      setEditingFamilyMemberId(null);
      setFamilyForm(defaultFamilyForm);
    }

    setIsFamilyDrawerOpen(true);
  }

  function closeFamilyDrawer() {
    setIsFamilyDrawerOpen(false);
    setEditingFamilyMemberId(null);
    setFamilyForm(defaultFamilyForm);
  }

  function selectFamilyMember(memberId: string | null) {
    setSelectedFamilyMemberId(memberId);
    setActivityLogPage(0);
    void loadActivityLogsPage(0, undefined, false, memberId);
  }

  async function handleFamilyAvatarUpload(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0] ?? null;

    if (!file) {
      return;
    }

    try {
      const avatarDataUrl = await readAvatarThumbnailAsDataUrl(file);
      setFamilyForm((current) => ({
        ...current,
        avatarDataUrl,
      }));
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      event.target.value = "";
    }
  }

  async function loadFamilyMembers(signal?: AbortSignal, showLoading = false) {
    if (showLoading) {
      setLoadingFamilyMembers(true);
    }

    try {
      const response = await fetch(getFamilyMembersUrl(), {
        signal,
      });

      if (!response.ok) {
        throw new Error("We could not load the family list.");
      }

      const payload = (await response.json()) as FamilyMember[];
      setFamilyMembers(payload);
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") {
        setError((loadError as Error).message);
      }
    } finally {
      if (showLoading) {
        setLoadingFamilyMembers(false);
      }
    }
  }

  async function loadActivityLogsPage(
    page: number,
    signal?: AbortSignal,
    showLoading = false,
    familyMemberId: string | null = selectedFamilyMemberId,
  ) {
    if (showLoading) {
      setLoadingActivityLogs(true);
    } else {
      setLoadingActivityPage(true);
    }

    try {
      const params = new URLSearchParams({
        limit: String(activityLogPageSize),
        offset: String(page * activityLogPageSize),
      });

      if (familyMemberId) {
        params.set("familyMemberId", familyMemberId);
      }

      const response = await fetch(
        `${getActivityLogUrl()}?${params.toString()}`,
        {
          signal,
        },
      );

      if (!response.ok) {
        throw new Error("We could not load the activity log.");
      }

      const payload = (await response.json()) as ActivityLogResponse;
      setActivityLogs(payload.items);
      setActivityLogTotalCount(payload.totalCount);
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") {
        setError((loadError as Error).message);
      }
    } finally {
      if (showLoading) {
        setLoadingActivityLogs(false);
      } else {
        setLoadingActivityPage(false);
      }
    }
  }

  useEffect(() => {
    const onPopState = () => setRoute(getRouteFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    document.title =
      route.kind === "calendar"
        ? `Calendar · ${selectedSchedule?.medicine ?? "Pill Track"}`
        : route.kind === "family"
          ? "Family Members · Pill Track"
          : "Pill Track";
  }, [route, selectedSchedule]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    document.body.style.overflow =
      (isMedicationModalOpen && route.kind === "home") || isFamilyDrawerOpen
        ? "hidden"
        : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [isMedicationModalOpen, isFamilyDrawerOpen, route.kind]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadInitialData() {
      setLoadingSchedules(true);
      setLoadingFamilyMembers(true);
      setLoadingActivityLogs(true);
      setActivityLogPage(0);

      try {
        await Promise.all([
          (async () => {
            try {
              const response = await fetch(apiUrl("/api/schedules"), {
                signal: controller.signal,
              });

              if (!response.ok) {
                throw new Error("We could not load the schedule list.");
              }

              const payload = (await response.json()) as ScheduleSummary[];
              setSchedules(payload);
            } catch (loadError) {
              if ((loadError as Error).name !== "AbortError") {
                setError((loadError as Error).message);
              }
            }
          })(),
          (async () => {
            try {
              const params = new URLSearchParams({
                limit: String(activityLogPageSize),
                offset: "0",
              });

              const response = await fetch(
                `${getActivityLogUrl()}?${params.toString()}`,
                {
                  signal: controller.signal,
                },
              );

              if (!response.ok) {
                throw new Error("We could not load the activity log.");
              }

              const payload = (await response.json()) as ActivityLogResponse;
              setActivityLogs(payload.items);
              setActivityLogTotalCount(payload.totalCount);
            } catch (loadError) {
              if ((loadError as Error).name !== "AbortError") {
                setError((loadError as Error).message);
              }
            }
          })(),
          (async () => {
            await loadFamilyMembers(controller.signal, true);
          })(),
        ]);
      } finally {
        setLoadingSchedules(false);
        setLoadingFamilyMembers(false);
        setLoadingActivityLogs(false);
      }
    }

    void loadInitialData();

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (route.kind !== "calendar") {
      return;
    }

    const token = route.token;
    const controller = new AbortController();

    async function loadScheduleDetail() {
      setLoadingDetail(true);
      setError(null);

      try {
        const response = await fetch(getScheduleDetailUrl(token), {
          signal: controller.signal,
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(payload?.error ?? "We could not load that schedule.");
        }

        const payload = (await response.json()) as ScheduleDetail;
        setSelectedSchedule(payload);
        setMonthCursor(startOfMonth(parseDateOnly(payload.startDate)));
      } catch (loadError) {
        if ((loadError as Error).name !== "AbortError") {
          setError((loadError as Error).message);
          setSelectedSchedule(null);
        }
      } finally {
        setLoadingDetail(false);
      }
    }

    void loadScheduleDetail();

    return () => controller.abort();
  }, [route]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const isEditing = Boolean(editingScheduleToken);
      const response = await fetch(
        isEditing
          ? getUpdateScheduleUrl(editingScheduleToken ?? "")
          : apiUrl("/api/schedules"),
        {
          method: isEditing ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            medicine: form.medicine.trim(),
            familyMemberId: form.familyMemberId || null,
            scheduleType: form.scheduleType,
            durationDays: Number(form.durationDays),
            timesPerDay:
              form.scheduleType === "supplement" ? 1 : Number(form.timesPerDay),
            startTime:
              form.scheduleType === "prescribed" ? form.startTime : null,
            startDate: form.startDate,
            timezoneOffsetMinutes: new Date().getTimezoneOffset(),
          }),
        },
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? "We could not save this schedule.");
      }

      const payload = (await response.json()) as ScheduleDetail;
      const nextSummary: ScheduleSummary = {
        id: payload.id,
        token: payload.token,
        medicine: payload.medicine,
        familyMemberId: payload.familyMemberId,
        familyMemberName: payload.familyMemberName,
        scheduleType: payload.scheduleType,
        durationDays: payload.durationDays,
        timesPerDay: payload.timesPerDay,
        startTime: payload.startTime,
        startDate: payload.startDate,
        createdAt: payload.createdAt,
        totalIntakes: payload.totalIntakes,
        completedIntakes: payload.completedIntakes,
      };

      setSchedules((current) => [
        nextSummary,
        ...current.filter((schedule) => schedule.token !== nextSummary.token),
      ]);
      setForm(defaultForm);
      setEditingScheduleToken(null);
      setIsMedicationModalOpen(false);
      setStatus(
        isEditing
          ? `${nextSummary.medicine} was updated and saved.`
          : `${nextSummary.medicine} was saved and added to the schedule list.`,
      );
      setActivityLogPage(0);
      void loadActivityLogsPage(0, undefined, false, selectedFamilyMemberId);
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleFamilySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingFamilyMember(true);
    setError(null);

    try {
      const isEditing = Boolean(editingFamilyMemberId);
      const response = await fetch(
        isEditing
          ? getFamilyMemberUpdateUrl(editingFamilyMemberId ?? "")
          : getFamilyMembersUrl(),
        {
          method: isEditing ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: familyForm.name.trim(),
            birthdate: familyForm.birthdate,
            gender: familyForm.gender,
            avatarDataUrl: familyForm.avatarDataUrl,
          }),
        },
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          payload?.error ?? "We could not save that family member.",
        );
      }

      const payload = (await response.json()) as FamilyMember;
      setFamilyMembers((current) => {
        if (isEditing) {
          return current.map((member) =>
            member.id === payload.id ? payload : member,
          );
        }

        return [payload, ...current];
      });
      closeFamilyDrawer();
      setStatus(
        isEditing
          ? `${payload.name} was updated.`
          : `${payload.name} was added to the family list.`,
      );
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSavingFamilyMember(false);
    }
  }

  async function deleteFamilyMember(member: FamilyMember) {
    const confirmed = window.confirm(
      `Delete ${member.name}? Schedules assigned to this family member will be unassigned.`,
    );

    if (!confirmed) {
      return;
    }

    setError(null);
    setStatus("Deleting family member...");

    try {
      const response = await fetch(getFamilyMemberDeleteUrl(member.id), {
        method: "DELETE",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          payload?.error ?? "We could not delete that family member.",
        );
      }

      const deletedMemberId = member.id;
      setFamilyMembers((current) =>
        current.filter((currentMember) => currentMember.id !== deletedMemberId),
      );
      setSelectedFamilyMemberId((current) =>
        current === deletedMemberId ? null : current,
      );
      setSchedules((current) =>
        current.map((schedule) =>
          schedule.familyMemberId === deletedMemberId
            ? { ...schedule, familyMemberId: null, familyMemberName: null }
            : schedule,
        ),
      );
      if (editingFamilyMemberId === member.id) {
        closeFamilyDrawer();
      }
      setStatus(`${member.name} was removed from the family list.`);
    } catch (deleteError) {
      setError((deleteError as Error).message);
    }
  }

  async function deleteSchedule(scheduleToken: string) {
    const confirmed = window.confirm(
      "Delete this schedule? This will remove the schedule and all of its pill intakes.",
    );

    if (!confirmed) {
      return;
    }

    setError(null);
    setStatus("Deleting schedule...");

    try {
      const response = await fetch(getDeleteScheduleUrl(scheduleToken), {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("We could not delete that schedule.");
      }

      setSchedules((current) =>
        current.filter((schedule) => schedule.token !== scheduleToken),
      );

      if (selectedSchedule?.token === scheduleToken) {
        setSelectedSchedule(null);
        navigate("/");
      }

      if (editingScheduleToken === scheduleToken) {
        setEditingScheduleToken(null);
        setForm(defaultForm);
      }

      setStatus("Schedule deleted.");
      setActivityLogPage(0);
      void loadActivityLogsPage(0, undefined, false, selectedFamilyMemberId);
    } catch (deleteError) {
      setError((deleteError as Error).message);
    }
  }

  function beginEditingSchedule(schedule: ScheduleSummary) {
    setForm({
      medicine: schedule.medicine,
      familyMemberId: schedule.familyMemberId ?? "",
      scheduleType: schedule.scheduleType,
      durationDays: String(schedule.durationDays),
      timesPerDay: String(schedule.timesPerDay),
      startTime: schedule.startTime ?? "08:00",
      startDate: schedule.startDate,
    });
    setEditingScheduleToken(schedule.token);
    setIsMedicationModalOpen(true);
    setStatus(`Editing ${schedule.medicine}.`);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function cancelEditingSchedule() {
    setEditingScheduleToken(null);
    setForm(defaultForm);
    setIsMedicationModalOpen(false);
    setStatus("Editing cancelled.");
  }

  function openNewMedicationModal() {
    setEditingScheduleToken(null);
    setForm(defaultForm);
    setIsMedicationModalOpen(true);
    setError(null);
    setStatus("Add a new medication schedule.");
  }

  function closeMedicationModal() {
    setIsMedicationModalOpen(false);
    setEditingScheduleToken(null);
    setForm(defaultForm);
    setStatus("Medication form closed.");
  }

  async function toggleCompleted(intakeId: string, nextCompleted: boolean) {
    if (!selectedSchedule) {
      return;
    }

    const selectedToken = selectedSchedule.token;
    const previous = selectedSchedule;
    const targetIntake = selectedSchedule.intakes.find(
      (intake) => intake.id === intakeId,
    );
    const wasCompleted = Boolean(targetIntake?.completedAt);

    if (!targetIntake) {
      return;
    }

    if (nextCompleted && isMissedDose(selectedSchedule, targetIntake)) {
      setError("This dose has already passed and is marked as Missed Dose.");
      setStatus("Missed Dose.");
      return;
    }

    setStatus("Saving completion state...");

    setSelectedSchedule({
      ...selectedSchedule,
      intakes: selectedSchedule.intakes.map((intake) =>
        intake.id === intakeId
          ? {
              ...intake,
              completedAt: nextCompleted ? new Date().toISOString() : null,
              status: nextCompleted ? "completed" : "pending",
              missedAt: nextCompleted ? null : intake.missedAt,
            }
          : intake,
      ),
    });

    try {
      const response = await fetch(getUpdateIntakeUrl(intakeId), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          completed: nextCompleted,
        }),
      });

      if (!response.ok) {
        throw new Error("We could not update that intake.");
      }

      const payload = (await response.json()) as {
        intake: {
          id: string;
          completedAt: string | null;
          status: "pending" | "completed" | "missed";
          missedAt: string | null;
        };
      };

      setSelectedSchedule((current) =>
        current
          ? {
              ...current,
              intakes: current.intakes.map((intake) =>
                intake.id === payload.intake.id
                  ? {
                      ...intake,
                      completedAt: payload.intake.completedAt,
                      status: payload.intake.status,
                      missedAt: payload.intake.missedAt,
                    }
                  : intake,
              ),
            }
          : current,
      );

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
        );
      }

      setStatus(
        nextCompleted ? "Intake marked complete." : "Intake marked as pending.",
      );
      setActivityLogPage(0);
      void loadActivityLogsPage(0, undefined, false, selectedFamilyMemberId);
    } catch (toggleError) {
      setSelectedSchedule(previous);
      setError((toggleError as Error).message);
    }
  }

  const totalActivityPages = Math.max(
    Math.ceil(activityLogTotalCount / activityLogPageSize),
    1,
  );
  const activityLogStart =
    activityLogTotalCount === 0 ? 0 : activityLogPage * activityLogPageSize + 1;
  const activityLogEnd = Math.min(
    (activityLogPage + 1) * activityLogPageSize,
    activityLogTotalCount,
  );

  const completedCount =
    selectedSchedule?.intakes.filter((intake) => intake.completedAt).length ??
    0;
  const totalCount = selectedSchedule?.intakes.length ?? 0;
  const completionPercent =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const visibleSchedules = selectedFamilyMemberId
    ? schedules.filter(
        (schedule) => schedule.familyMemberId === selectedFamilyMemberId,
      )
    : schedules;
  const scheduleSource = selectedFamilyMemberId ? visibleSchedules : schedules;
  const visibleActivityLogs = selectedFamilyMemberId
    ? activityLogs.filter(
        (entry) => entry.familyMemberId === selectedFamilyMemberId,
      )
    : activityLogs;
  const prescribedSchedules = scheduleSource.filter(
    (schedule) => schedule.scheduleType === "prescribed",
  );
  const supplementSchedules = scheduleSource.filter(
    (schedule) => schedule.scheduleType === "supplement",
  );
  const isMedicationListLoading = loadingSchedules || loadingFamilyMembers;
  const calendarView =
    selectedSchedule && route.kind === "calendar"
      ? buildCalendarCells(selectedSchedule, monthCursor)
      : null;
  const portalRoot =
    typeof document === "undefined" ? null : document.body;
  const navigationItems = [
    { label: "Home", path: "/" },
    { label: "Family Members", path: "/family" },
  ] as const;

  return (
    <main className="app-shell">
      <div className="noise" aria-hidden="true" />
      <AppBar
        position="sticky"
        elevation={0}
        color="transparent"
        sx={{
          zIndex: (muiTheme) => muiTheme.zIndex.appBar,
          backgroundColor: "rgba(255, 255, 255, 0.96)",
          borderBottom: "1px solid rgba(41, 182, 246, 0.12)",
          boxShadow: "none",
          backdropFilter: "none",
        }}
      >
        <Toolbar
          disableGutters
          sx={{
            width: "min(1240px, 100%)",
            mx: "auto",
            px: { xs: 2, md: 3 },
            py: { xs: 1.25, md: 1.5 },
            minHeight: { xs: 72, md: 84 },
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 2,
          }}
        >
          <Button
            disableRipple
            onClick={() => navigate("/")}
            sx={{
              color: "var(--ink)",
              textTransform: "none",
              fontFamily: "var(--heading)",
              fontSize: { xs: "1.28rem", md: "1.5rem" },
              fontWeight: 700,
              letterSpacing: "-0.05em",
              lineHeight: 1,
              px: 0,
              minWidth: 0,
              "&:hover": {
                backgroundColor: "transparent",
                opacity: 0.9,
              },
            }}
          >
            Pill Track
          </Button>

          {!isCompactNav ? (
            <Box
              component="nav"
              aria-label="Primary"
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                ml: "auto",
              }}
            >
              {navigationItems.map((item) => {
                const isActive =
                  (route.kind === "home" && item.path === "/") ||
                  (route.kind === "family" && item.path === "/family");

                return (
                  <Button
                    key={item.path}
                    type="button"
                    onClick={() => navigate(item.path)}
                    variant="text"
                    aria-current={isActive ? "page" : undefined}
                    sx={{
                      minHeight: 44,
                      px: 2,
                      borderRadius: 999,
                      textTransform: "none",
                      fontFamily: "var(--body)",
                      fontSize: "0.98rem",
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                      color: isActive ? "#ffffff" : "rgba(15, 38, 56, 0.72)",
                      background: isActive
                        ? "linear-gradient(135deg, var(--accent), var(--accent-2))"
                        : "rgba(255, 255, 255, 0.78)",
                      border: "1px solid",
                      borderColor: isActive
                        ? "transparent"
                        : "rgba(41, 182, 246, 0.14)",
                      boxShadow: isActive
                        ? "0 10px 22px rgba(41, 182, 246, 0.18)"
                        : "none",
                      transition:
                        "transform 180ms ease, background-color 180ms ease, color 180ms ease, box-shadow 180ms ease",
                      "&:hover": {
                        background: isActive
                          ? "linear-gradient(135deg, var(--accent), var(--accent-2))"
                          : "rgba(225, 245, 254, 0.82)",
                        transform: "translateY(-1px)",
                      },
                    }}
                  >
                    {item.label}
                  </Button>
                );
              })}
            </Box>
          ) : (
            <Box sx={{ ml: "auto" }}>
              <IconButton
                aria-label="Open navigation menu"
                aria-controls={navAnchorEl ? "navigation-menu" : undefined}
                aria-haspopup="true"
                aria-expanded={navAnchorEl ? "true" : undefined}
                onClick={openNavMenu}
                sx={{
                  color: "var(--ink)",
                  border: "1px solid rgba(41, 182, 246, 0.14)",
                  backgroundColor: "rgba(255, 255, 255, 0.82)",
                  borderRadius: 999,
                  width: 44,
                  height: 44,
                  "&:hover": {
                    backgroundColor: "rgba(225, 245, 254, 0.82)",
                  },
                }}
              >
                <MenuIcon fontSize="small" />
              </IconButton>
              <Menu
                id="navigation-menu"
                anchorEl={navAnchorEl}
                open={Boolean(navAnchorEl)}
                onClose={closeNavMenu}
                anchorOrigin={{
                  vertical: "bottom",
                  horizontal: "right",
                }}
                transformOrigin={{
                  vertical: "top",
                  horizontal: "right",
                }}
                slotProps={{
                  paper: {
                    sx: {
                      mt: 1.25,
                      minWidth: 240,
                      borderRadius: 3,
                      border: "1px solid rgba(41, 182, 246, 0.14)",
                      boxShadow: "0 22px 42px rgba(15, 38, 56, 0.14)",
                      backgroundColor: "rgba(255, 255, 255, 0.98)",
                      overflow: "hidden",
                    },
                  },
                }}
              >
                {navigationItems.map((item) => {
                  const isActive =
                    (route.kind === "home" && item.path === "/") ||
                    (route.kind === "family" && item.path === "/family");

                  return (
                    <MenuItem
                      key={item.path}
                      selected={isActive}
                      onClick={() => navigate(item.path)}
                      sx={{
                        minHeight: 48,
                        fontFamily: "var(--body)",
                        fontSize: "0.98rem",
                        fontWeight: 600,
                        color: "var(--ink)",
                        "&.Mui-selected": {
                          background:
                            "linear-gradient(135deg, rgba(41, 182, 246, 0.12), rgba(129, 212, 250, 0.12))",
                        },
                        "&.Mui-selected:hover": {
                          background:
                            "linear-gradient(135deg, rgba(41, 182, 246, 0.16), rgba(129, 212, 250, 0.16))",
                        },
                      }}
                    >
                      {item.label}
                    </MenuItem>
                  );
                })}
              </Menu>
            </Box>
          )}
        </Toolbar>
      </AppBar>

      <section className="panel app-frame">
        <div className="app-main">
          {route.kind === "home" ? (
            <>
              <header className="topbar">
                <div>
                  <p className="eyebrow">Pill tracker</p>
                  <h1>Medication, without losing the list.</h1>
                </div>
              </header>

              <section
                className="family-avatar-strip-section"
                aria-label="Family member selector"
              >
                <div className="family-avatar-strip">
                  {loadingFamilyMembers ? (
                    Array.from({ length: 4 }, (_, index) => (
                      <button
                        className="family-avatar-button skeleton-card"
                        type="button"
                        key={`family-avatar-skeleton-${index}`}
                        disabled
                      >
                        <span
                          className="skeleton-line skeleton-avatar-circle"
                          aria-hidden="true"
                        />
                        <span
                          className="skeleton-line skeleton-avatar-label"
                          aria-hidden="true"
                        />
                      </button>
                    ))
                  ) : familyMembers.length === 0 ? (
                    Array.from({ length: 4 }, (_, index) => (
                      <button
                        className="family-avatar-button skeleton-card"
                        type="button"
                        key={`family-avatar-empty-skeleton-${index}`}
                        disabled
                      >
                        <span
                          className="skeleton-line skeleton-avatar-circle"
                          aria-hidden="true"
                        />
                        <span
                          className="skeleton-line skeleton-avatar-label"
                          aria-hidden="true"
                        />
                      </button>
                    ))
                  ) : (
                    familyMembers.map((member) => {
                      const isSelected = member.id === selectedFamilyMemberId;

                      return (
                        <button
                          className={`family-avatar-button ${isSelected ? "selected" : ""}`}
                          type="button"
                          key={member.id}
                          onClick={() =>
                            selectFamilyMember(isSelected ? null : member.id)
                          }
                          aria-pressed={isSelected}
                          aria-label={
                            isSelected
                              ? `${member.name} selected`
                              : `Show medications for ${member.name}`
                          }
                        >
                          <Avatar
                            className="family-avatar-image"
                            src={member.avatarDataUrl ?? undefined}
                            alt={member.name}
                            sx={{ width: 100, height: 100 }}
                          >
                            {getInitials(member.name)}
                          </Avatar>
                        </button>
                      );
                    })
                  )}
                </div>
              </section>

              <section className="schedule-list-section">
                {isMedicationListLoading ? (
                  <div className="schedule-grid">
                    {Array.from({ length: 3 }, (_, skeletonIndex) => (
                      <article
                        className="schedule-card skeleton-card"
                        key={`home-medication-skeleton-${skeletonIndex}`}
                      >
                        <div className={`schedule-card-banner tone-${(skeletonIndex % 5) + 1}`}>
                          <div className="schedule-card-banner-overlay" />
                          <div className="schedule-card-banner-copy">
                            <span
                              className="skeleton-line skeleton-card-kicker"
                              aria-hidden="true"
                            />
                            <span
                              className="skeleton-line skeleton-card-title"
                              aria-hidden="true"
                            />
                            <span
                              className="skeleton-line skeleton-card-copy"
                              aria-hidden="true"
                            />
                          </div>
                        </div>
                        <div className="schedule-card-body">
                          <dl className="schedule-meta-grid">
                            {Array.from({ length: 4 }, (_, metaIndex) => (
                              <div
                                key={`home-medication-skeleton-meta-${skeletonIndex}-${metaIndex}`}
                              >
                                <dt>
                                  <span
                                    className="skeleton-line skeleton-meta-label"
                                    aria-hidden="true"
                                  />
                                </dt>
                                <dd>
                                  <span
                                    className="skeleton-line skeleton-meta-value"
                                    aria-hidden="true"
                                  />
                                </dd>
                              </div>
                            ))}
                          </dl>
                          <div className="schedule-card-actions">
                            <span
                              className="skeleton-line skeleton-action"
                              aria-hidden="true"
                            />
                            <span
                              className="skeleton-line skeleton-action"
                              aria-hidden="true"
                            />
                            <span
                              className="skeleton-line skeleton-action"
                              aria-hidden="true"
                            />
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : selectedFamilyMemberId && visibleSchedules.length === 0 ? (
                  <div className="list-empty family-selected-empty">
                    <p>No medications</p>
                  </div>
                ) : (
                  <div>
                    {(
                      [
                        {
                          scheduleType: "prescribed" as const,
                          schedules: prescribedSchedules,
                        },
                        {
                          scheduleType: "supplement" as const,
                          schedules: supplementSchedules,
                        },
                      ] as const
                    ).map(
                      (
                        { scheduleType, schedules: sectionSchedules },
                        index,
                      ) => (
                        <article
                          className={`tracker-section-${scheduleType}`}
                          key={scheduleType}
                        >
                          <div className="section-heading">
                            <div>
                              <p className="section-label">
                                {getScheduleTypeLabel(scheduleType)}
                              </p>
                              <Badge
                                badgeContent={sectionSchedules.length}
                                color="success"
                                sx={{ right: "-10px" }}
                              >
                                <h2 style={{ position: "relative", right: "10px" }}>{getScheduleSectionCopy(scheduleType)}</h2>
                              </Badge>
                            </div>
                            {/* <p className="lead">
                              {sectionSchedules.length === 0
                                ? null
                                : `${sectionSchedules.length}`}
                            </p> */}
                          </div>

                          {loadingSchedules ? (
                            <div className="schedule-grid">
                              {Array.from({ length: 3 }, (_, skeletonIndex) => (
                                <article
                                  className="schedule-card skeleton-card"
                                  key={`${scheduleType}-schedule-skeleton-${skeletonIndex}`}
                                >
                                  <div
                                    className={`schedule-card-banner tone-${((index + skeletonIndex) % 5) + 1}`}
                                  >
                                    <div className="schedule-card-banner-overlay" />
                                    <div className="schedule-card-banner-copy">
                                      <span
                                        className="skeleton-line skeleton-card-kicker"
                                        aria-hidden="true"
                                      />
                                      <span
                                        className="skeleton-line skeleton-card-title"
                                        aria-hidden="true"
                                      />
                                      <span
                                        className="skeleton-line skeleton-card-copy"
                                        aria-hidden="true"
                                      />
                                    </div>
                                  </div>
                                  <div className="schedule-card-body">
                                    <dl className="schedule-meta-grid">
                                      {Array.from(
                                        { length: 4 },
                                        (_, metaIndex) => (
                                          <div
                                            key={`${scheduleType}-schedule-skeleton-meta-${skeletonIndex}-${metaIndex}`}
                                          >
                                            <dt>
                                              <span
                                                className="skeleton-line skeleton-meta-label"
                                                aria-hidden="true"
                                              />
                                            </dt>
                                            <dd>
                                              <span
                                                className="skeleton-line skeleton-meta-value"
                                                aria-hidden="true"
                                              />
                                            </dd>
                                          </div>
                                        ),
                                      )}
                                    </dl>
                                    <div className="schedule-card-actions">
                                      <span
                                        className="skeleton-line skeleton-action"
                                        aria-hidden="true"
                                      />
                                      <span
                                        className="skeleton-line skeleton-action"
                                        aria-hidden="true"
                                      />
                                      <span
                                        className="skeleton-line skeleton-action"
                                        aria-hidden="true"
                                      />
                                    </div>
                                  </div>
                                </article>
                              ))}
                            </div>
                          ) : sectionSchedules.length === 0 ? (
                            <div className="schedule-grid">
                              {Array.from({ length: 3 }).map(
                                (_, skeletonIndex) => (
                                  <article
                                    className="schedule-card"
                                    key={`skeleton-${skeletonIndex}`}
                                  >
                                    <div
                                      className={`schedule-card-banner tone-${(skeletonIndex % 5) + 1}`}
                                    >
                                      <div className="schedule-card-banner-overlay" />
                                      <div className="schedule-card-banner-copy">
                                        <span
                                          className="skeleton-line skeleton-banner-kicker"
                                          aria-hidden="true"
                                        />
                                        <span
                                          className="skeleton-line skeleton-banner-title"
                                          aria-hidden="true"
                                        />
                                        <span
                                          className="skeleton-line skeleton-banner-subtitle"
                                          aria-hidden="true"
                                        />
                                      </div>
                                    </div>
                                    <div className="schedule-card-body">
                                      <dl>
                                        {Array.from({ length: 2 }).map(
                                          (_, metaIndex) => (
                                            <div key={`meta-${metaIndex}`}>
                                              <dt>
                                                <span
                                                  className="skeleton-line skeleton-meta-label"
                                                  aria-hidden="true"
                                                />
                                              </dt>
                                              <dd>
                                                <span
                                                  className="skeleton-line skeleton-meta-value"
                                                  aria-hidden="true"
                                                />
                                              </dd>
                                            </div>
                                          ),
                                        )}
                                      </dl>
                                      <div className="schedule-card-actions">
                                        <span
                                          className="skeleton-line skeleton-action"
                                          aria-hidden="true"
                                        />
                                        <span
                                          className="skeleton-line skeleton-action"
                                          aria-hidden="true"
                                        />
                                        <span
                                          className="skeleton-line skeleton-action"
                                          aria-hidden="true"
                                        />
                                      </div>
                                    </div>
                                  </article>
                                ),
                              )}
                            </div>
                          ) : (
                            <div className="schedule-grid">
                              {sectionSchedules.map(
                                (schedule, sectionIndex) => (
                                  <article
                                    className="schedule-card"
                                    key={schedule.id}
                                  >
                                    <div
                                      className={`schedule-card-banner tone-${((index + sectionIndex) % 5) + 1}`}
                                    >
                                      <div className="schedule-card-banner-overlay" />
                                      <div className="schedule-card-banner-copy">
                                        <span className="schedule-card-banner-kicker">
                                          {getScheduleTypeLabel(
                                            schedule.scheduleType,
                                          )}
                                        </span>
                                        <button
                                          className="schedule-card-title-button"
                                          type="button"
                                          onClick={() =>
                                            navigate(
                                              `/calendar/${encodeURIComponent(schedule.token)}`,
                                            )
                                          }
                                        >
                                          {schedule.medicine}
                                        </button>
                                        <p>
                                          {schedule.scheduleType ===
                                          "supplement"
                                            ? "Daily check-in · Complete anytime today"
                                            : `First dose at ${formatTimeInputLabel(
                                                schedule.startTime ?? "08:00",
                                              )} · ${schedule.durationDays} days`}
                                        </p>
                                      </div>
                                    </div>

                                    <div className="schedule-card-body">
                                      <dl className="schedule-meta-grid">
                                        <div>
                                          <dt>Duration</dt>
                                          <dd>{schedule.durationDays} days</dd>
                                        </div>
                                        <div>
                                          <dt>Tracker</dt>
                                          <dd>
                                            {schedule.scheduleType ===
                                            "supplement"
                                              ? "Daily check-in"
                                              : `${schedule.timesPerDay} doses / day`}
                                          </dd>
                                        </div>
                                        <div>
                                          <dt>Start date</dt>
                                          <dd>
                                            {formatDateLabel(
                                              schedule.startDate,
                                            )}
                                          </dd>
                                        </div>
                                        <div>
                                          <dt>Created</dt>
                                          <dd>
                                            {formatDateLabel(
                                              schedule.createdAt,
                                            )}
                                          </dd>
                                        </div>
                                        <div>
                                          <dt>Assigned to</dt>
                                          <dd>
                                            {schedule.familyMemberName ??
                                              "Unassigned"}
                                          </dd>
                                        </div>
                                        <div>
                                          <dt>Start time</dt>
                                          <dd>
                                            {schedule.scheduleType ===
                                            "supplement"
                                              ? "Anytime"
                                              : formatTimeInputLabel(
                                                  schedule.startTime ?? "08:00",
                                                )}
                                          </dd>
                                        </div>
                                      </dl>

                                      {schedule.scheduleType ===
                                      "prescribed" ? (
                                        <div className="schedule-dose-preview">
                                          <p>Generated dose times</p>
                                          <div className="dose-preview-list">
                                            {getPrescribedDoseTimes(
                                              schedule.timesPerDay,
                                              schedule.startTime ?? "08:00",
                                            ).map((doseTime) => (
                                              <span key={doseTime}>
                                                {doseTime}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                      ) : null}

                                      <div className="schedule-card-actions">
                                        <button
                                          className="schedule-icon-button"
                                          type="button"
                                          onClick={() =>
                                            navigate(
                                              `/calendar/${encodeURIComponent(schedule.token)}`,
                                            )
                                          }
                                          aria-label={`View ${schedule.medicine}`}
                                          title="View"
                                        >
                                          <VisibilityOutlinedIcon fontSize="small" />
                                        </button>
                                        <button
                                          className="schedule-icon-button"
                                          type="button"
                                          onClick={() =>
                                            beginEditingSchedule(schedule)
                                          }
                                          aria-label={`Edit ${schedule.medicine}`}
                                          title="Edit"
                                        >
                                          <EditOutlinedIcon fontSize="small" />
                                        </button>
                                        <button
                                          className="schedule-icon-button danger"
                                          type="button"
                                          onClick={() =>
                                            void deleteSchedule(schedule.token)
                                          }
                                          aria-label={`Delete ${schedule.medicine}`}
                                          title="Delete"
                                        >
                                          <DeleteOutlineRoundedIcon fontSize="small" />
                                        </button>
                                      </div>
                                    </div>
                                  </article>
                                ),
                              )}
                            </div>
                          )}
                        </article>
                      ),
                    )}
                  </div>
                )}
              </section>
              <div className="dashboard-grid">
                <section className="activity-log-card">
                  <div className="section-heading">
                    <div>
                      <p className="section-label">User Activity Log</p>
                      <h2>What the app has tracked lately</h2>
                    </div>
                  </div>

                  <div className="activity-log-list">
                    {loadingActivityLogs || loadingActivityPage ? (
                      Array.from(
                        { length: activityLogPageSize },
                        (_, index) => (
                          <article
                            className="activity-log-item skeleton-card"
                            key={`activity-skeleton-${index}`}
                          >
                            <span
                              className="skeleton-line skeleton-badge"
                              aria-hidden="true"
                            />
                            <div className="activity-log-copy">
                              <span
                                className="skeleton-line skeleton-log-title"
                                aria-hidden="true"
                              />
                              <span
                                className="skeleton-line skeleton-log-copy"
                                aria-hidden="true"
                              />
                            </div>
                          </article>
                        ),
                      )
                    ) : visibleActivityLogs.length === 0 ? (
                      <div className="list-empty">
                        <p>
                          {selectedFamilyMemberId
                            ? "No activity log"
                            : "No activity yet. Create a schedule to start the log."}
                        </p>
                      </div>
                    ) : (
                      visibleActivityLogs.map((entry) => (
                        <article className="activity-log-item" key={entry.id}>
                          <span
                            className={`activity-log-badge ${entry.actionType}`}
                          >
                            {getActivityLabel(entry.actionType)}
                          </span>
                          <div className="activity-log-copy">
                            <p>{entry.summary}</p>
                            <span>
                              {entry.medicine ?? "Pill schedule"} ·{" "}
                              {formatActivityTimestamp(entry.createdAt)}
                            </span>
                          </div>
                        </article>
                      ))
                    )}
                  </div>

                  <div className="activity-pagination">
                    <p className="activity-pagination-label">
                      {activityLogTotalCount === 0
                        ? "No activity recorded yet"
                        : `Showing ${activityLogStart}-${activityLogEnd} of ${activityLogTotalCount}`}
                    </p>
                    <div className="activity-pagination-controls">
                      <button
                        className="ghost-button"
                        type="button"
                        disabled={
                          activityLogPage === 0 ||
                          loadingActivityLogs ||
                          loadingActivityPage
                        }
                        onClick={() => {
                          const nextPage = Math.max(activityLogPage - 1, 0);
                          setActivityLogPage(nextPage);
                          void loadActivityLogsPage(nextPage);
                        }}
                      >
                        Previous
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        disabled={
                          activityLogPage >= totalActivityPages - 1 ||
                          loadingActivityLogs ||
                          loadingActivityPage ||
                          activityLogTotalCount === 0
                        }
                        onClick={() => {
                          const nextPage = activityLogPage + 1;
                          setActivityLogPage(nextPage);
                          void loadActivityLogsPage(nextPage);
                        }}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </section>
              </div>
              <button
                className="floating-add-button"
                type="button"
                onClick={openNewMedicationModal}
              >
                <span aria-hidden="true">+</span>
                <span>Add medication</span>
              </button>

              {portalRoot && isMedicationModalOpen
                ? createPortal(
                    <div
                      className="modal-backdrop"
                      role="presentation"
                      onClick={closeMedicationModal}
                    >
                      <div
                        className="modal-panel"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="medication-modal-title"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="modal-header">
                          <div>
                            <p className="section-label">Medication</p>
                            <h2 id="medication-modal-title">
                              {editingScheduleToken
                                ? "Edit medication schedule"
                                : "Add medication schedule"}
                            </h2>
                          </div>
                          <button
                            className="modal-close"
                            type="button"
                            onClick={closeMedicationModal}
                            aria-label="Close medication form"
                          >
                            ×
                          </button>
                        </div>

                        <form
                          className="pill-form pill-form-modal"
                          onSubmit={handleSubmit}
                        >
                          <label>
                            <span>Track Type</span>
                            <div
                              className="pill-select-group"
                              role="radiogroup"
                              aria-label="Track type"
                            >
                              <label className="pill-option">
                                <input
                                  type="radio"
                                  name="scheduleType"
                                  value="prescribed"
                                  checked={form.scheduleType === "prescribed"}
                                  onChange={() =>
                                    setForm((current) => ({
                                      ...current,
                                      scheduleType: "prescribed",
                                      timesPerDay:
                                        current.timesPerDay === "1"
                                          ? "3"
                                          : current.timesPerDay,
                                      startTime: current.startTime || "08:00",
                                    }))
                                  }
                                />
                                <span>
                                  <strong>Prescribed Medication</strong>
                                  <em>Doctor-directed intake</em>
                                </span>
                              </label>
                              <label className="pill-option">
                                <input
                                  type="radio"
                                  name="scheduleType"
                                  value="supplement"
                                  checked={form.scheduleType === "supplement"}
                                  onChange={() =>
                                    setForm((current) => ({
                                      ...current,
                                      scheduleType: "supplement",
                                      timesPerDay: "1",
                                      startTime: "",
                                    }))
                                  }
                                />
                                <span>
                                  <strong>Supplement / Vitamins</strong>
                                  <em>Daily wellness tracking</em>
                                </span>
                              </label>
                            </div>
                          </label>

                          <label>
                            <span>Assign to family member</span>
                            <select
                              name="familyMemberId"
                              value={form.familyMemberId}
                              onChange={(event) =>
                                setForm((current) => ({
                                  ...current,
                                  familyMemberId: event.target.value,
                                }))
                              }
                            >
                              <option value="">Unassigned</option>
                              {familyMembers.map((member) => (
                                <option key={member.id} value={member.id}>
                                  {member.name}
                                </option>
                              ))}
                            </select>
                          </label>

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

                          {form.scheduleType === "prescribed" ? (
                            <>
                              <label>
                                <span>Start Time</span>
                                <input
                                  name="startTime"
                                  type="time"
                                  required
                                  value={form.startTime}
                                  onChange={(event) =>
                                    setForm((current) => ({
                                      ...current,
                                      startTime: event.target.value,
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

                              <div className="dose-preview-card" aria-live="polite">
                                <span>Calculated dose times</span>
                                <div className="dose-preview-list">
                                  {getPrescribedDoseTimes(
                                    Number(form.timesPerDay),
                                    form.startTime || "08:00",
                                  ).map((doseTime) => (
                                    <strong key={doseTime}>{doseTime}</strong>
                                  ))}
                                </div>
                                <p>
                                  Adjust the start time to recalculate the 24-hour
                                  dose window.
                                </p>
                              </div>
                            </>
                          ) : (
                            <div className="dose-preview-card supplement-note">
                              <span>Supplement / Vitamins</span>
                              <p>
                                Simple daily tracking. Mark complete any time during
                                the day. If it stays pending until tomorrow, it
                                becomes a Missed Dose.
                              </p>
                            </div>
                          )}

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

                          <div className="modal-actions">
                            <button type="submit" disabled={saving}>
                              {saving
                                ? "Saving..."
                                : editingScheduleToken
                                  ? "Update schedule"
                                  : "Submit"}
                            </button>

                            <button
                              className="ghost-button"
                              type="button"
                              onClick={
                                editingScheduleToken
                                  ? cancelEditingSchedule
                                  : closeMedicationModal
                              }
                            >
                              {editingScheduleToken ? "Cancel edit" : "Close"}
                            </button>
                          </div>

                          <p className="form-footer">
                            {editingScheduleToken
                              ? "You are editing an existing schedule. Saving will update the record and add a history entry."
                              : "Schedules appear immediately in the list below and stay saved for the next visit."}
                          </p>
                        </form>
                      </div>
                    </div>,
                    portalRoot,
                  )
                : null}
            </>
          ) : route.kind === "family" ? (
            <>
              <header className="topbar">
                <div>
                  <p className="eyebrow">Family Members</p>
                  <h1>My Family</h1>
                </div>
              </header>

              <section className="">
                <div className="">
                  <div className="family-panel-heading family-panel-heading-inline">
                    <div>
                      <p className="section-label">Members</p>
                      <h3>Everyone in the family group</h3>
                    </div>
                    <button
                      className="view-button family-add-button"
                      type="button"
                      onClick={() => openFamilyDrawer()}
                    >
                      + Add New
                    </button>
                  </div>

                  <div className="family-list">
                    {loadingFamilyMembers ? (
                      Array.from({ length: 4 }, (_, index) => (
                        <article
                          className="family-member skeleton-card"
                          key={`family-skeleton-${index}`}
                        >
                          <div className="family-member-header">
                            <span
                              className="skeleton-line skeleton-family-avatar"
                              aria-hidden="true"
                            />
                            <div className="family-member-copy">
                              <span
                                className="skeleton-line skeleton-family-name"
                                aria-hidden="true"
                              />
                              <span
                                className="skeleton-line skeleton-family-meta"
                                aria-hidden="true"
                              />
                            </div>
                          </div>
                          <div className="family-member-divider" />
                          <div className="family-member-meta-grid">
                            <span
                              className="skeleton-line skeleton-family-meta"
                              aria-hidden="true"
                            />
                            <span
                              className="skeleton-line skeleton-family-meta"
                              aria-hidden="true"
                            />
                            <span
                              className="skeleton-line skeleton-family-meta"
                              aria-hidden="true"
                            />
                            <span
                              className="skeleton-line skeleton-family-meta"
                              aria-hidden="true"
                            />
                          </div>
                          <div className="family-member-footer">
                            <span
                              className="skeleton-line skeleton-family-action"
                              aria-hidden="true"
                            />
                            <span
                              className="skeleton-line skeleton-family-action"
                              aria-hidden="true"
                            />
                          </div>
                        </article>
                      ))
                    ) : familyMembers.length === 0 ? (
                      <div className="list-empty">
                        <p>Add a family member to start the list.</p>
                      </div>
                    ) : (
                      familyMembers.map((member) => (
                        <article className="family-member" key={member.id}>
                          <div className="family-member-header">
                            <Avatar
                              className="family-member-avatar"
                              src={member.avatarDataUrl ?? undefined}
                              alt={member.name}
                              sx={{ height: 70 }}
                            >
                              {getInitials(member.name)}
                            </Avatar>
                            <div className="family-member-copy">
                              <strong>{member.name}</strong>
                              <span className="family-member-subtitle">
                                {getGenderLabel(member.gender)} ·{" "}
                                {formatBirthdateLabel(member.birthdate)}
                              </span>
                            </div>
                          </div>
                          <div className="family-member-divider" />
                          <div className="family-member-meta-grid">
                            <div>
                              <span>Birthdate</span>
                              <strong>
                                {formatBirthdateLabel(member.birthdate)}
                              </strong>
                            </div>
                            <div>
                              <span>Gender</span>
                              <strong>{getGenderLabel(member.gender)}</strong>
                            </div>
                            <div>
                              <span>Status</span>
                              <strong>Active</strong>
                            </div>
                            <div>
                              <span>Added</span>
                              <strong>
                                {formatDateLabel(member.createdAt)}
                              </strong>
                            </div>
                          </div>
                          <div className="family-member-footer">
                            <button
                              className="family-icon-button"
                              type="button"
                              onClick={() => openFamilyDrawer(member)}
                              aria-label={`Edit ${member.name}`}
                              title="Edit"
                            >
                              <EditOutlinedIcon fontSize="small" />
                            </button>
                            <button
                              className="family-icon-button danger"
                              type="button"
                              onClick={() => void deleteFamilyMember(member)}
                              aria-label={`Delete ${member.name}`}
                              title="Delete"
                            >
                              <DeleteOutlineRoundedIcon fontSize="small" />
                            </button>
                          </div>
                        </article>
                      ))
                    )}
                  </div>
                </div>
              </section>

              {portalRoot && isFamilyDrawerOpen
                ? createPortal(
                    <div
                      className="family-drawer-backdrop"
                      role="presentation"
                      onClick={closeFamilyDrawer}
                    >
                      <aside
                        className="family-drawer"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="family-drawer-title"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="family-drawer-header">
                          <div>
                            <p className="section-label">Family Members</p>
                            <h3 id="family-drawer-title">
                              {editingFamilyMemberId
                                ? "Edit Family Member"
                                : "Add New Family Member"}
                            </h3>
                          </div>
                          <button
                            className="modal-close"
                            type="button"
                            onClick={closeFamilyDrawer}
                            aria-label="Close family drawer"
                          >
                            ×
                          </button>
                        </div>

                        <div className="family-drawer-actions"></div>

                        <form
                          className="family-form family-drawer-form"
                          onSubmit={handleFamilySubmit}
                        >
                          <label>
                            <span>Family member name</span>
                            <input
                              autoComplete="off"
                              name="familyName"
                              placeholder="Ava Khan"
                              required
                              value={familyForm.name}
                              onChange={(event) =>
                                setFamilyForm((current) => ({
                                  ...current,
                                  name: event.target.value,
                                }))
                              }
                            />
                          </label>

                          <label>
                            <span>Birthdate</span>
                            <input
                              name="familyBirthdate"
                              type="date"
                              required
                              value={familyForm.birthdate}
                              onChange={(event) =>
                                setFamilyForm((current) => ({
                                  ...current,
                                  birthdate: event.target.value,
                                }))
                              }
                            />
                          </label>

                          <label>
                            <span>Gender</span>
                            <div
                              className="family-gender-group"
                              role="radiogroup"
                              aria-label="Gender"
                            >
                              <label className="family-gender-option">
                                <input
                                  type="radio"
                                  name="familyGender"
                                  value="male"
                                  checked={familyForm.gender === "male"}
                                  onChange={() =>
                                    setFamilyForm((current) => ({
                                      ...current,
                                      gender: "male",
                                    }))
                                  }
                                />
                                <span>Male</span>
                              </label>
                              <label className="family-gender-option">
                                <input
                                  type="radio"
                                  name="familyGender"
                                  value="female"
                                  checked={familyForm.gender === "female"}
                                  onChange={() =>
                                    setFamilyForm((current) => ({
                                      ...current,
                                      gender: "female",
                                    }))
                                  }
                                />
                                <span>Female</span>
                              </label>
                            </div>
                          </label>

                          <label>
                            <span>Image thumbnail</span>
                            <div className="family-avatar-upload">
                              <Avatar
                                className="family-avatar-preview"
                                src={familyForm.avatarDataUrl ?? undefined}
                                alt={familyForm.name || "Family member preview"}
                              >
                                {getInitials(familyForm.name || "FM")}
                              </Avatar>
                              <div className="family-avatar-upload-copy">
                                <input
                                  accept="image/*"
                                  name="familyAvatar"
                                  type="file"
                                  onChange={handleFamilyAvatarUpload}
                                />
                                <p>
                                  Upload a small thumbnail to show this member on
                                  the landing page and family list.
                                </p>
                                {familyForm.avatarDataUrl ? (
                                  <button
                                    className="ghost-button family-avatar-clear"
                                    type="button"
                                    onClick={() =>
                                      setFamilyForm((current) => ({
                                        ...current,
                                        avatarDataUrl: null,
                                      }))
                                    }
                                  >
                                    Remove image
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          </label>

                          <div className="drawer-actions">
                            <button type="submit" disabled={savingFamilyMember}>
                              {savingFamilyMember
                                ? "Saving..."
                                : editingFamilyMemberId
                                  ? "Update family member"
                                  : "Add family member"}
                            </button>

                            <button
                              className="ghost-button"
                              type="button"
                              onClick={closeFamilyDrawer}
                            >
                              Close
                            </button>
                          </div>

                          <p className="form-footer">
                            These members are stored separately from medication
                            schedules.
                          </p>
                        </form>
                      </aside>
                    </div>,
                    portalRoot,
                  )
                : null}
            </>
          ) : (
            <>
              <button
                className="back-link"
                type="button"
                onClick={() => navigate("/")}
              >
                Back to Homepage
              </button>
              <header className="topbar">
                <div>
                  {loadingDetail ? (
                    <div
                      className="skeleton-line skeleton-headline"
                      aria-hidden="true"
                    />
                  ) : (
                    <h1>{selectedSchedule?.medicine ?? "Schedule calendar"}</h1>
                  )}
                </div>
              </header>
              <section className="calendar-page">
                <div className="calendar-toolbar">
                  <div className="calendar-header-actions">
                    <div className="month-nav">
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() =>
                          setMonthCursor(
                            (current) =>
                              new Date(
                                current.getFullYear(),
                                current.getMonth() - 1,
                                1,
                              ),
                          )
                        }
                      >
                        Previous
                      </button>
                      <strong>{calendarView?.monthLabel ?? "Month"}</strong>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() =>
                          setMonthCursor(
                            (current) =>
                              new Date(
                                current.getFullYear(),
                                current.getMonth() + 1,
                                1,
                              ),
                          )
                        }
                      >
                        Next
                      </button>
                    </div>

                    <div className="calendar-summary">
                      {loadingDetail ? (
                        <>
                          <span
                            className="skeleton-line skeleton-summary-value"
                            aria-hidden="true"
                          />
                          <span
                            className="skeleton-line skeleton-summary-copy"
                            aria-hidden="true"
                          />
                          <span
                            className="skeleton-line skeleton-progress"
                            aria-hidden="true"
                          />
                        </>
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {loadingDetail ? (
                  <div className="calendar-skeleton" aria-hidden="true">
                    <div className="calendar-skeleton-surface">
                      <div className="calendar-scroll">
                        <div className="calendar-weekdays">
                          {weekdayLabels.map((label) => (
                            <div
                              className="skeleton-line skeleton-weekday"
                              key={label}
                            />
                          ))}
                        </div>

                        <div className="calendar-weeks">
                          {Array.from({ length: 5 }, (_, weekIndex) => (
                            <div
                              className="calendar-week"
                              key={`skeleton-week-${weekIndex}`}
                            >
                              {Array.from({ length: 7 }, (_, dayIndex) => (
                                <article
                                  className="calendar-cell calendar-skeleton-cell"
                                  key={`skeleton-cell-${weekIndex}-${dayIndex}`}
                                >
                                  <header className="calendar-day-head">
                                    <span className="skeleton-line skeleton-day-number" />
                                  </header>
                                  <div className="calendar-day-intakes">
                                    <span className="skeleton-pill" />
                                    <span className="skeleton-pill" />
                                  </div>
                                </article>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : selectedSchedule && calendarView ? (
                  <>
                    <div className="calendar-surface">
                      <div className="calendar-scroll">
                        <div className="calendar-weekdays" aria-hidden="true">
                          {weekdayLabels.map((label) => (
                            <div key={label}>{label}</div>
                          ))}
                        </div>
                        <div className="calendar-weeks">
                          {calendarView.weeks.map((week, weekIndex) => (
                            <div className="calendar-week" key={`${weekIndex}`}>
                              {week.map((cell) => (
                                <article
                                  key={cell.dateKey}
                                  className={[
                                    "calendar-cell",
                                    cell.isCurrentMonth ? "current" : "outside",
                                    cell.isInSchedule ? "in-schedule" : "",
                                    cell.isToday ? "today" : "",
                                  ]
                                    .filter(Boolean)
                                    .join(" ")}
                                >
                                  <header className="calendar-day-head">
                                    <span className="calendar-day-number">
                                      {cell.dayNumber}
                                    </span>
                                  </header>
                                  <div className="calendar-day-intakes">
                                    {cell.items.length === 0 ? (
                                      <span className="calendar-empty">
                                        {selectedSchedule.scheduleType ===
                                        "supplement"
                                          ? "No check-ins"
                                          : "No doses"}
                                      </span>
                                    ) : (
                                      cell.items.map((intake) => {
                                        const completed = Boolean(
                                          intake.completedAt,
                                        );
                                        const missed = isMissedDose(
                                          selectedSchedule,
                                          intake,
                                        );
                                        const blocked = !completed && missed;

                                        return (
                                          <div
                                            key={intake.id}
                                            className="intake-item"
                                          >
                                            <button
                                              className={`intake-chip ${completed ? "completed" : ""} ${missed ? "missed" : ""} ${blocked ? "blocked" : ""}`}
                                              type="button"
                                              aria-pressed={completed}
                                              aria-label={
                                                completed
                                                  ? `${intake.doseLabel} completed`
                                                  : missed
                                                    ? `${intake.doseLabel} missed dose`
                                                    : `${intake.doseLabel} mark complete`
                                              }
                                              disabled={blocked}
                                              onClick={() =>
                                                void toggleCompleted(
                                                  intake.id,
                                                  !completed,
                                                )
                                              }
                                            >
                                              <span
                                                className={`intake-check ${completed ? "checked" : ""}`}
                                                aria-hidden="true"
                                              >
                                                {completed ? "✓" : "○"}
                                              </span>
                                              <span className="intake-chip-body">
                                                <span className="intake-chip-status">
                                                  {completed
                                                    ? "Completed"
                                                    : missed
                                                      ? "Missed Dose"
                                                      : "Pending"}
                                                </span>
                                                <span className="intake-chip-time">
                                                  {getIntakeTimeLabel(
                                                    selectedSchedule,
                                                    intake,
                                                  )}
                                                </span>
                                                <span className="intake-chip-label">
                                                  {intake.doseLabel}
                                                </span>
                                              </span>
                                            </button>

                                            {completed && intake.completedAt ? (
                                              <p className="completed-stamp">
                                                Completed{" "}
                                                {formatCompletedTimestamp(
                                                  intake.completedAt,
                                                )}
                                              </p>
                                            ) : missed ? (
                                              <p className="missed-stamp">
                                                Missed Dose
                                              </p>
                                            ) : null}
                                          </div>
                                        );
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
                      Click the check control on any pill chip to mark it
                      complete or uncheck it later.
                    </p>
                  </>
                ) : (
                  <div className="list-empty">
                    <p>{error ?? "We could not load that schedule."}</p>
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        <footer className="status-bar" aria-live="polite">
          <span>{status}</span>
          {error ? <span className="error-text">{error}</span> : null}
        </footer>
      </section>
    </main>
  );
}

export default App;
