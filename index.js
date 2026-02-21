const path = require("path");
try {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
} catch (e) {
  console.log(".env not loaded:", e.message);
}
const axios = require("axios");
const cron = require("node-cron");
const { google } = require("googleapis");
const OpenAI = require("openai");
const fs = require("fs");
const http = require("http");

// ══════════════════════  CONFIG  ══════════════════════════════
const CONFIG = {
  timezone: process.env.TIMEZONE || "Asia/Dhaka",
  cronSchedule: process.env.CRON_SCHEDULE || "00 8 * * *",
  spreadsheetId: process.env.SPREADSHEET_ID,
  explicitSheetRange: process.env.SHEET_RANGE,
  sheetName: process.env.SHEET_NAME,
  phoneNumberId: process.env.PHONE_NUMBER_ID,
  whatsappToken: process.env.WHATSAPP_TOKEN,
  recipientPhone: process.env.YOUR_PHONE,
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  routineSpreadsheetId: "1-_DSIrbns4SsUI7PmiJ1fzpcVAHXlZVN1u5-e_ThubY",
  cronSecret: process.env.CRON_SECRET || "",
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const RUN_ONCE_MODE = process.argv.includes("--once");

function getArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return "";
}

function normalizeDayName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const match = WEEKDAY_NAMES.find((day) => day.toLowerCase() === raw);
  return match || "";
}

const FORCED_DAY_NAME = RUN_ONCE_MODE
  ? normalizeDayName(getArgValue("--day"))
  : "";

const routineCache = {};

function detectRoutineChange(cacheKey, data) {
  const key = String(cacheKey || "routine").toLowerCase();
  const currentSignature = JSON.stringify(data);
  const previousSignature = routineCache[key]?.signature || "";
  const previousUpdatedAt = routineCache[key]?.updatedAt || "";
  const hasPrevious = Object.prototype.hasOwnProperty.call(routineCache, key);
  const changed = hasPrevious && previousSignature !== currentSignature;
  const previousCount = routineCache[key]?.count || 0;
  const updatedAt = new Date().toISOString();
  routineCache[key] = {
    signature: currentSignature,
    updatedAt,
    count: Array.isArray(data) ? data.length : 0,
  };
  return {
    changed,
    previousCount,
    currentCount: Array.isArray(data) ? data.length : 0,
    updatedAt,
    previousUpdatedAt,
  };
}

function formatUpdateDateTime(isoString) {
  if (!isoString) return "";
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CONFIG.timezone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(parsed);
}

function buildRoutineUpdateNotification(dayName, classes, updatedAt) {
  const safeDay = String(dayName || "today").trim();
  const updatedAtText = formatUpdateDateTime(updatedAt);
  const updatedLine = updatedAtText
    ? `Updated at: ${updatedAtText} (${CONFIG.timezone})\n`
    : "";
  if (!Array.isArray(classes) || classes.length === 0) {
    return `Dear Ziban,\n\nYour class routine has been updated by your university.\n\nDay: ${safeDay}\n${updatedLine}Classes: No classes scheduled for this day.\n\nPlease review the latest routine sheet for details.\n\nBest regards.`;
  }
  const classLines = classes
    .map((item, index) => `${index + 1}. ${item.time} - ${item.details}`)
    .join("\n");
  return `Dear Ziban,\n\nYour class routine has been updated by your university.\n\nDay: ${safeDay}\n${updatedLine}Updated class schedule:\n${classLines}\n\nPlease follow this updated timing.\n\nBest regards.`;
}

function validateConfig() {
  const required = [
    "spreadsheetId",
    "phoneNumberId",
    "whatsappToken",
    "recipientPhone",
  ];
  const missing = required.filter((field) => !CONFIG[field]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment values: ${missing.join(", ")}`);
  }
  if (!cron.validate(CONFIG.cronSchedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: ${CONFIG.cronSchedule}`);
  }
}

// ══════════════════════  AI CLIENTS  ═════════════════════════
let perplexityClient;
function getPerplexityClient() {
  if (!CONFIG.perplexityApiKey) {
    throw new Error("PERPLEXITY_API_KEY is required to format task summaries.");
  }
  if (!perplexityClient) {
    perplexityClient = new OpenAI({
      baseURL: "https://api.perplexity.ai",
      apiKey: CONFIG.perplexityApiKey,
    });
  }
  return perplexityClient;
}

let openRouterClient;
function getOpenRouterClient() {
  if (!CONFIG.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required to format task summaries.");
  }
  if (!openRouterClient) {
    openRouterClient = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: CONFIG.openRouterApiKey,
    });
  }
  return openRouterClient;
}

// ══════════════════════  HELPERS  ════════════════════════════
function getRecipientPhone() {
  return (CONFIG.recipientPhone || "").replace(/\D/g, "");
}

function getTodayISODate() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function getTodayDayName() {
  if (FORCED_DAY_NAME) {
    return FORCED_DAY_NAME;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CONFIG.timezone,
    weekday: "long",
  });
  return formatter.format(new Date());
}

function getTodayDisplayDate() {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: CONFIG.timezone,
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  return formatter.format(new Date());
}

function formatDisplayDate(value) {
  const iso = normalizeSheetDate(value);
  if (!iso) return String(value || "").trim();
  const [year, month, day] = iso.split("-");
  const utcDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(utcDate);
}

function formatRoutineSlotLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const slotMatch = raw.match(/^slot\s*>?\s*(\d+)\s*(.*)$/i);
  if (slotMatch) {
    const [, slotNumber, rest] = slotMatch;
    const suffix = rest ? ` ${rest.trim()}` : "";
    return `Slot ${slotNumber} >${suffix}`;
  }
  if (/^slot\b/i.test(raw)) {
    const rest = raw.replace(/^slot\s*/i, "").trim();
    return `Slot ${rest} >`;
  }
  return `Slot > ${raw}`;
}

// ══════════════════════  GOOGLE SHEETS  ═════════════════════
function normalizeSheetDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, first, second, year] = slashMatch;
    let month, day;
    if (Number(first) > 12) {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().split("T")[0];
  }
  return "";
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function buildTaskObjects(rows) {
  return rows.map((row) => ({
    task: row[0] || "",
    note: row[1] || "",
    date: row[2] || "",
    status: row[3] || "",
  }));
}

async function resolveSheetRange(sheets) {
  if (CONFIG.explicitSheetRange) return CONFIG.explicitSheetRange;
  if (CONFIG.sheetName) return `${CONFIG.sheetName}!A2:D`;
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: CONFIG.spreadsheetId,
    fields: "sheets(properties(title))",
  });
  const firstSheet = metadata.data.sheets?.[0]?.properties?.title;
  if (!firstSheet) throw new Error("No sheet tabs found in spreadsheet.");
  return `${firstSheet}!A2:D`;
}

function getGoogleAuth() {
  if (process.env.GOOGLE_CREDENTIALS) {
    const credentials = JSON.parse(
      Buffer.from(process.env.GOOGLE_CREDENTIALS, "base64").toString("utf-8")
    );
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
  }
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "credentials.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

async function getTodayTasks() {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const range = await resolveSheetRange(sheets);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range,
  });
  const rows = response.data.values || [];
  console.log(`Reading rows from range: ${range}`);
  const today = getTodayISODate();
  const todayTasks = rows.filter((row) => {
    const rowDate = normalizeSheetDate(row[2]);
    const rowStatus = normalizeStatus(row[3]);
    return rowDate === today && rowStatus === "pending";
  });
  const overdueTasks = rows.filter((row) => {
    const rowDate = normalizeSheetDate(row[2]);
    const rowStatus = normalizeStatus(row[3]);
    return rowDate && rowDate < today && rowStatus === "pending";
  });
  return {
    today: buildTaskObjects(todayTasks),
    overdue: buildTaskObjects(overdueTasks),
  };
}

// ══════════════════════  CLASS ROUTINE  ═════════════════════
async function getRoutineSheetRows() {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.routineSpreadsheetId,
    range: "Sheet1!A1:G30",
  });
  return response.data.values || [];
}

function normalizeRoutineRows(rows) {
  return (rows || []).map((row) => row.map((cell) => String(cell || "").trim()));
}

async function getTodayClassRoutine(preloadedRows) {
  const rows = preloadedRows || (await getRoutineSheetRows());
  if (rows.length === 0) return [];
  const header = rows[0];
  const slotTimes = header.slice(1).map((s) => s.replace(/\n/g, " ").trim());
  const todayDay = getTodayDayName();
  console.log(`Looking for classes on: ${todayDay}`);
  let dayStartIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    const cell = (rows[i][0] || "").trim();
    if (cell.toLowerCase() === todayDay.toLowerCase()) {
      dayStartIndex = i;
      break;
    }
  }
  if (dayStartIndex === -1) return [];
  const classes = [];
  for (let i = dayStartIndex; i < rows.length; i++) {
    const cell = (rows[i][0] || "").trim();
    if (
      i > dayStartIndex &&
      cell &&
      ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].includes(
        cell.toLowerCase()
      )
    ) {
      break;
    }
    for (let j = 1; j < rows[i].length; j++) {
      const classInfo = (rows[i][j] || "").trim();
      if (classInfo) {
        classes.push({
          time: formatRoutineSlotLabel(slotTimes[j - 1] || `Slot ${j}`),
          details: classInfo.replace(/\n/g, ", "),
        });
      }
    }
  }
  return classes;
}

async function formatClassRoutine(classes) {
  const addSpaceAfterEachClass = (text) =>
    String(text || "").replace(
      /(\r?\n\d+\.[^\r\n]*)(\r?\n)(?=\d+\.)/g,
      "$1\n\n"
    );

  try {
    const todayDay = getTodayDayName();
    const prompt = `
You are Ziban's personal class schedule assistant.

Today is ${todayDay}. Here are Ziban's classes for today:
${JSON.stringify(classes)}

Each class has: time (slot time) and details (teacher, course code, section, room).

Rules:
- Address Ziban by name.
- Show today's day.
- List each class with its time and details in numbered format.
- Add one blank line after each class item.
- Keep it concise and under 200 words.
- This message will be sent on WhatsApp, so do NOT use any markdown, bold, italic, headers, tables, bullet symbols, or special formatting.
- Use plain text only with numbered lists and line breaks.
- Use a formal and professional tone throughout.
- Keep wording clear and respectful; avoid casual slang.
`;
    const response = await getOpenRouterClient().chat.completions.create({
      model: "google/gemini-2.5-flash-lite-preview-09-2025",
      messages: [{ role: "user", content: prompt }],
    });
    return addSpaceAfterEachClass(response.choices[0].message.content);
  } catch (err) {
    console.error("AI routine formatting failed, using plain format:", err.message);
    const todayDay = getTodayDayName();
    const lines = classes.map((c, i) => `${i + 1}. ${c.time} - ${c.details}`);
    return `Dear Ziban,\n\nYour classes for ${todayDay}:\n\n${lines.join("\n\n")}\n\nWishing you a productive day.\n\nBest regards.`;
  }
}

// ══════════════════════  FORMAT WITH LLM  ═══════════════════
function buildPlainTaskSummary(todayTasks, overdueTasks) {
  const lines = todayTasks.map(
    (t, i) => `${i + 1}. ${t.task}${t.note ? " - " + t.note : ""}`
  );
  let msg = `Your tasks for today:\n\n${lines.join("\n")}`;
  if (overdueTasks.length > 0) {
    const overdueLines = overdueTasks.map(
      (t, i) =>
        `${i + 1}. ${t.task} (was due ${formatDisplayDate(t.date)})${t.note ? " - " + t.note : ""}`
    );
    msg += `\n\nOverdue tasks:\n${overdueLines.join("\n")}`;
  }
  msg += `\n\nStay focused and productive!`;
  return msg;
}

async function formatTasks(todayTasks, overdueTasks) {
  try {
    const formattedTodayTasks = todayTasks.map((task) => ({
      ...task,
      date: formatDisplayDate(task.date),
    }));
    const formattedOverdueTasks = overdueTasks.map((task) => ({
      ...task,
      date: formatDisplayDate(task.date),
    }));
    let taskSection = `Today's tasks:\n${JSON.stringify(formattedTodayTasks)}`;
    if (overdueTasks.length > 0) {
      taskSection += `\n\nOverdue tasks (date has passed but still pending):\n${JSON.stringify(formattedOverdueTasks)}`;
    }
    const now = getTodayDisplayDate();
    const dayName = getTodayDayName();
    const prompt = `
  You are Ziban's personal productivity assistant.

  Day: ${dayName}
  Date: ${now}

${taskSection}

Each task has these fields: task (name), note (extra details), date (M/DD/YYYY), status.

Rules:
- Address Ziban by name.
- Today's day and date are already provided above. Use them exactly as given.
- Keep day and date on separate lines (do not combine like "Friday, 20 Feb 2026").
- First list today's tasks with numbers.
- If there are overdue tasks, list them separately under an "Overdue" section with numbered list and their original due dates.
- If a task has a note, include it next to the task.
- Add a short motivational line at the end.
- Keep it under 300 words.
- This message will be sent on WhatsApp, so do NOT use any markdown, bold, italic, headers, tables, bullet symbols, or special formatting.
- Use plain text only with numbered lists and line breaks.
- Write in a warm, formal and professional tone.
`;
    const response = await getOpenRouterClient().chat.completions.create({
      model: "google/gemini-2.5-flash-lite-preview-09-2025",
      messages: [{ role: "user", content: prompt }],
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error("AI formatting failed, using plain format:", err.message);
    return buildPlainTaskSummary(todayTasks, overdueTasks);
  }
}

// ══════════════════════  SEND WHATSAPP  ═════════════════════
async function sendWhatsApp(message) {
  const res = await axios.post(
    `https://graph.facebook.com/v21.0/${CONFIG.phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: getRecipientPhone(),
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.whatsappToken}`,
        "Content-Type": "application/json",
      },
    }
  );
  console.log("WhatsApp API response:", JSON.stringify(res.data, null, 2));
}

async function sendWhatsAppTemplate(name, date, tasks) {
  const res = await axios.post(
    `https://graph.facebook.com/v18.0/${CONFIG.phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: getRecipientPhone(),
      type: "template",
      template: {
        name: "daily_task_reminder",
        language: { code: "en_US" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: name },
              { type: "text", text: date },
              { type: "text", text: tasks },
            ],
          },
        ],
      },
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.whatsappToken}`,
        "Content-Type": "application/json",
      },
    }
  );
  console.log(
    "WhatsApp template response:",
    JSON.stringify(res.data, null, 2)
  );
}

// ══════════════════════  MAIN DAILY JOB  ════════════════════
async function dailyJob() {
  try {
    console.log("Fetching tasks from Google Sheets...");
    const { today: todayTasks, overdue: overdueTasks } = await getTodayTasks();
    console.log(
      `Found ${todayTasks.length} task(s) for today, ${overdueTasks.length} overdue task(s).`
    );
    if (!CONFIG.openRouterApiKey) {
      console.log(
        "OPENROUTER_API_KEY is missing. Task formatting will be skipped."
      );
    }
    if (todayTasks.length === 0 && overdueTasks.length === 0) {
      console.log("No tasks found. Sending default message...");
      await sendWhatsApp("Hello Ziban there are no task today");
      console.log("Default message sent successfully!");
    } else {
      console.log("Formatting tasks with AI...");
      const message = await formatTasks(todayTasks, overdueTasks);
      console.log("Formatted message:\n", message);
      console.log("Sending WhatsApp message...");
      await sendWhatsApp(message);
      console.log("Message sent successfully!");
    }

    // --- Class Routine ---
    console.log("Fetching class routine...");
    const routineRows = await getRoutineSheetRows();
    const routineChange = detectRoutineChange(
      "routine_sheet",
      normalizeRoutineRows(routineRows)
    );
    const classes = await getTodayClassRoutine(routineRows);
    const dayName = getTodayDayName();
    console.log(`Found ${classes.length} class(es) for today.`);
    if (routineChange.changed) {
      const notifyMessage = buildRoutineUpdateNotification(
        dayName,
        classes,
        routineChange.updatedAt
      );
      console.log("Routine update detected. Sending update notification...");
      await sendWhatsApp(notifyMessage);
      console.log("Routine update notification sent successfully!");
    }
    if (classes.length > 0) {
      console.log("Formatting class routine with AI...");
      const routineMessage = await formatClassRoutine(classes);
      console.log("Routine message:\n", routineMessage);
      console.log("Sending class routine WhatsApp message...");
      await sendWhatsApp(routineMessage);
      console.log("Class routine message sent successfully!");
    } else {
      console.log("No classes for today.");
    }
  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
  }
}

function startScheduler() {
  cron.schedule(
    CONFIG.cronSchedule,
    async () => {
      console.log("Running scheduled daily task...");
      await dailyJob();
    },
    { timezone: CONFIG.timezone }
  );
  console.log(
    `Scheduler started with CRON '${CONFIG.cronSchedule}' in timezone '${CONFIG.timezone}'.`
  );
}

// ══════════════════════  EMBEDDED HTML  ═════════════════════
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Planner AI — Dashboard</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0f1117;--surface:#1a1d27;--card:#222639;
      --border:#2e3348;--text:#e2e4ed;--muted:#8b8fa7;
      --accent:#6c5ce7;--accent-hover:#7c6ff7;
      --green:#00b894;--red:#ff6b6b;--yellow:#ffd93d;
      --blue:#74b9ff;--radius:12px;
    }
    body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;min-height:100vh}
    .wrapper{max-width:1100px;margin:0 auto;padding:24px 16px}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;flex-wrap:wrap;gap:12px}
    header h1{font-size:1.6rem;font-weight:700;letter-spacing:-.5px}
    header h1 span{color:var(--accent)}
    .badge{font-size:.7rem;padding:3px 10px;border-radius:20px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
    .badge.online{background:rgba(0,184,148,.15);color:var(--green)}
    .badge.offline{background:rgba(255,107,107,.15);color:var(--red)}
    .grid{display:grid;gap:20px;grid-template-columns:1fr}
    @media(min-width:700px){.grid{grid-template-columns:1fr 1fr}}
    .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px;transition:border-color .2s}
    .card:hover{border-color:var(--accent)}
    .card.full{grid-column:1/-1}
    .card h2{font-size:1rem;margin-bottom:14px;display:flex;align-items:center;gap:8px}
    .card h2 .icon{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;font-size:.75rem}
    .env-table{width:100%;border-collapse:collapse;font-size:.85rem}
    .env-table td{padding:7px 0;border-bottom:1px solid var(--border);vertical-align:middle}
    .env-table td:first-child{color:var(--muted);width:45%;font-family:'Cascadia Code',monospace;font-size:.8rem}
    .env-table td:last-child{text-align:right}
    .dot{width:9px;height:9px;border-radius:50%;display:inline-block}
    .dot.ok{background:var(--green)}.dot.miss{background:var(--red)}
    .task-list,.routine-list{list-style:none;font-size:.88rem}
    .task-list li,.routine-list li{padding:10px 12px;margin-bottom:6px;background:var(--surface);border-radius:8px;display:flex;justify-content:space-between;align-items:center;gap:8px}
    .task-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .task-date{color:var(--muted);font-size:.78rem;white-space:nowrap}
    .task-status{font-size:.72rem;padding:2px 8px;border-radius:10px;font-weight:600;text-transform:uppercase}
    .task-status.pending{background:rgba(255,217,61,.12);color:var(--yellow)}
    .task-status.overdue{background:rgba(255,107,107,.12);color:var(--red)}
    .routine-list li .time{color:var(--blue);font-weight:600;min-width:120px;font-size:.82rem}
    .routine-list li .details{flex:1;color:var(--text)}
    .empty{text-align:center;color:var(--muted);padding:30px 0;font-size:.9rem}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
    .btn{padding:10px 22px;border:none;border-radius:8px;cursor:pointer;font-size:.85rem;font-weight:600;transition:all .2s;display:inline-flex;align-items:center;gap:6px}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn.primary{background:var(--accent);color:#fff}.btn.primary:hover:not(:disabled){background:var(--accent-hover)}
    .btn.secondary{background:var(--surface);color:var(--text);border:1px solid var(--border)}.btn.secondary:hover:not(:disabled){border-color:var(--accent)}
    .spinner{width:14px;height:14px;border:2px solid transparent;border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;display:none}
    @keyframes spin{to{transform:rotate(360deg)}}
    .console{background:#0d0f14;border:1px solid var(--border);border-radius:8px;padding:14px;font-family:'Cascadia Code',monospace;font-size:.78rem;max-height:220px;overflow-y:auto;color:var(--muted);line-height:1.8;margin-top:12px}
    .console .line{display:block}.console .line.ok{color:var(--green)}.console .line.err{color:var(--red)}.console .line.info{color:var(--blue)}
    .secret-row{display:flex;gap:8px;margin-bottom:14px;align-items:center}
    .secret-row input{flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.85rem;font-family:inherit;outline:none}
    .secret-row input:focus{border-color:var(--accent)}
    .secret-row label{font-size:.82rem;color:var(--muted);white-space:nowrap}
    footer{text-align:center;color:var(--muted);font-size:.75rem;margin-top:32px;padding-bottom:20px}
  </style>
</head>
<body>
  <div class="wrapper">
    <header>
      <h1>\\u{1F4CB} Planner <span>AI</span></h1>
      <span class="badge offline" id="statusBadge">checking\\u2026</span>
    </header>
    <div class="grid">
      <div class="card">
        <h2><span class="icon" style="background:rgba(108,92,231,.2);color:var(--accent)">\\u2699</span> Environment Variables</h2>
        <table class="env-table" id="envTable"><tbody><tr><td colspan="2" style="text-align:center;color:var(--muted)">Loading\\u2026</td></tr></tbody></table>
      </div>
      <div class="card">
        <h2><span class="icon" style="background:rgba(116,185,255,.2);color:var(--blue)">\\u{1F5A5}</span> System Info</h2>
        <table class="env-table" id="sysTable"><tbody><tr><td colspan="2" style="text-align:center;color:var(--muted)">Loading\\u2026</td></tr></tbody></table>
      </div>
      <div class="card">
        <h2><span class="icon" style="background:rgba(255,217,61,.15);color:var(--yellow)">\\u{1F4DD}</span> Today's Tasks</h2>
        <ul class="task-list" id="todayTasks"><li class="empty">Loading\\u2026</li></ul>
      </div>
      <div class="card">
        <h2><span class="icon" style="background:rgba(255,107,107,.15);color:var(--red)">\\u23F0</span> Overdue Tasks</h2>
        <ul class="task-list" id="overdueTasks"><li class="empty">Loading\\u2026</li></ul>
      </div>
      <div class="card full">
        <h2><span class="icon" style="background:rgba(0,184,148,.15);color:var(--green)">\\u{1F393}</span> Today's Class Routine</h2>
        <ul class="routine-list" id="routineList"><li class="empty">Loading\\u2026</li></ul>
      </div>
      <div class="card full">
        <h2><span class="icon" style="background:rgba(108,92,231,.2);color:var(--accent)">\\u{1F680}</span> Actions</h2>
        <div class="secret-row">
          <label for="cronSecret">Cron Secret:</label>
          <input type="password" id="cronSecret" placeholder="Enter CRON_SECRET if set\\u2026" autocomplete="off" />
        </div>
        <div class="actions">
          <button class="btn primary" id="btnRun" onclick="runDailyJob()">
            <span class="spinner" id="runSpinner"></span>
            \\u25B6 Run Daily Job
          </button>
          <button class="btn secondary" onclick="refreshAll()">\\u{1F504} Refresh Dashboard</button>
        </div>
        <div class="console" id="logConsole">
          <span class="line info">Dashboard ready. Waiting for actions\\u2026</span>
        </div>
      </div>
    </div>
    <footer>Planner AI Dashboard &bull; frontend powered by backend env &bull; <span id="footerTime"></span></footer>
  </div>
  <script>
    const ENV={};const SYS={};const BASE='';
    function $(id){return document.getElementById(id)}
    function log(msg,type=''){var con=$('logConsole');var line=document.createElement('span');line.className='line '+type;var ts=new Date().toLocaleTimeString();line.textContent='['+ts+'] '+msg;con.appendChild(line);con.scrollTop=con.scrollHeight}
    function dotHTML(ok){return '<span class="dot '+(ok?'ok':'miss')+'"></span> '+(ok?'Set':'Missing')}
    async function api(path){var res=await fetch(BASE+path);if(!res.ok)throw new Error(res.status+' '+res.statusText);return res.json()}
    async function loadStatus(){try{var data=await api('/api/status');var envRows=[['SPREADSHEET_ID',data.env.SPREADSHEET_ID],['WHATSAPP_TOKEN',data.env.WHATSAPP_TOKEN],['PHONE_NUMBER_ID',data.env.PHONE_NUMBER_ID],['YOUR_PHONE',data.env.YOUR_PHONE],['OPENROUTER_API_KEY',data.env.OPENROUTER_API_KEY],['GOOGLE_CREDENTIALS',data.env.GOOGLE_CREDENTIALS],['CRON_SECRET',data.env.CRON_SECRET]];$('envTable').querySelector('tbody').innerHTML=envRows.map(function(r){return '<tr><td>'+r[0]+'</td><td>'+dotHTML(r[1])+'</td></tr>'}).join('');var sysRows=[['Cron Schedule',data.sys.cronSchedule],['Timezone',data.sys.timezone],['.env file',data.sys.envFileExists?'\\u2705 Exists':'\\u274C Missing'],['credentials.json',data.sys.credFileExists?'\\u2705 Exists':'\\u274C Missing'],['__dirname',data.sys.dirname],['Node Env',data.sys.nodeEnv||'not set']];$('sysTable').querySelector('tbody').innerHTML=sysRows.map(function(r){return '<tr><td>'+r[0]+'</td><td style="color:var(--text)">'+r[1]+'</td></tr>'}).join('');$('statusBadge').textContent='online';$('statusBadge').className='badge online';log('Status loaded','ok')}catch(err){$('statusBadge').textContent='offline';$('statusBadge').className='badge offline';log('Failed to load status: '+err.message,'err')}}
    async function loadTasks(){try{var data=await api('/api/tasks');if(data.today.length===0){$('todayTasks').innerHTML='<li class="empty">No tasks for today \\u{1F389}</li>'}else{$('todayTasks').innerHTML=data.today.map(function(t){return '<li><span class="task-label">'+esc(t.task)+(t.note?' \\u2014 <small style="color:var(--muted)">'+esc(t.note)+'</small>':'')+'</span><span class="task-date">'+esc(t.date)+'</span><span class="task-status pending">pending</span></li>'}).join('')}if(data.overdue.length===0){$('overdueTasks').innerHTML='<li class="empty">No overdue tasks \\u2705</li>'}else{$('overdueTasks').innerHTML=data.overdue.map(function(t){return '<li><span class="task-label">'+esc(t.task)+(t.note?' \\u2014 <small style="color:var(--muted)">'+esc(t.note)+'</small>':'')+'</span><span class="task-date">'+esc(t.date)+'</span><span class="task-status overdue">overdue</span></li>'}).join('')}log('Tasks loaded: '+data.today.length+' today, '+data.overdue.length+' overdue','ok')}catch(err){$('todayTasks').innerHTML='<li class="empty">\\u26A0 '+esc(err.message)+'</li>';$('overdueTasks').innerHTML='<li class="empty">\\u26A0 '+esc(err.message)+'</li>';log('Failed to load tasks: '+err.message,'err')}}
    async function loadRoutine(){try{var data=await api('/api/routine');if(data.classes.length===0){$('routineList').innerHTML='<li class="empty">No classes today \\u{1F4DA}</li>'}else{$('routineList').innerHTML=data.classes.map(function(c){return '<li><span class="time">'+esc(c.time)+'</span><span class="details">'+esc(c.details)+'</span></li>'}).join('')}log('Routine loaded: '+data.classes.length+' class(es)','ok')}catch(err){$('routineList').innerHTML='<li class="empty">\\u26A0 '+esc(err.message)+'</li>';log('Failed to load routine: '+err.message,'err')}}
    async function runDailyJob(){var btn=$('btnRun');var spinner=$('runSpinner');btn.disabled=true;spinner.style.display='inline-block';log('Running daily job\\u2026','info');try{var secret=$('cronSecret').value.trim();var url='/api/run'+(secret?'?secret='+encodeURIComponent(secret):'');var res=await fetch(BASE+url);var data=await res.json();if(data.success){log('Daily job completed successfully!','ok')}else{log('Job failed: '+(data.error||'unknown error'),'err')}}catch(err){log('Request failed: '+err.message,'err')}finally{btn.disabled=false;spinner.style.display='none';loadTasks()}}
    function esc(str){var d=document.createElement('div');d.textContent=str||'';return d.innerHTML}
    function refreshAll(){log('Refreshing dashboard\\u2026','info');loadStatus();loadTasks();loadRoutine()}
    $('footerTime').textContent=new Date().toLocaleString();
    refreshAll();
    setInterval(function(){$('footerTime').textContent=new Date().toLocaleString();refreshAll()},60000);
  </script>
</body>
</html>`;

// ══════════════════════  HTTP SERVER  ═══════════════════════
const PORT = process.env.PORT || 3000;

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  // ── Root dashboard (HTML for hosting health checks) ──────
  if (parsedUrl.pathname === "/" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(DASHBOARD_HTML);
  }

  // ── API: status ────────────────────────────────
  if (parsedUrl.pathname === "/api/status" && req.method === "GET") {
    const credExists = fs.existsSync(path.join(__dirname, "credentials.json"));
    const envExists = fs.existsSync(path.join(__dirname, ".env"));
    return sendJSON(res, 200, {
      env: {
        SPREADSHEET_ID: !!CONFIG.spreadsheetId,
        WHATSAPP_TOKEN: !!CONFIG.whatsappToken,
        PHONE_NUMBER_ID: !!CONFIG.phoneNumberId,
        YOUR_PHONE: !!CONFIG.recipientPhone,
        OPENROUTER_API_KEY: !!CONFIG.openRouterApiKey,
        GOOGLE_CREDENTIALS: !!process.env.GOOGLE_CREDENTIALS,
        CRON_SECRET: !!CONFIG.cronSecret,
      },
      sys: {
        cronSchedule: CONFIG.cronSchedule,
        timezone: CONFIG.timezone,
        envFileExists: envExists,
        credFileExists: credExists,
        dirname: __dirname,
        nodeEnv: process.env.NODE_ENV || "",
      },
    });
  }

  // ── API: tasks ─────────────────────────────────
  if (parsedUrl.pathname === "/api/tasks" && req.method === "GET") {
    try {
      const { today, overdue } = await getTodayTasks();
      return sendJSON(res, 200, { today, overdue });
    } catch (err) {
      console.error("API /api/tasks error:", err.message);
      return sendJSON(res, 500, { error: err.message, today: [], overdue: [] });
    }
  }

  // ── API: routine ───────────────────────────────
  if (parsedUrl.pathname === "/api/routine" && req.method === "GET") {
    try {
      const classes = await getTodayClassRoutine();
      return sendJSON(res, 200, { day: getTodayDayName(), classes });
    } catch (err) {
      console.error("API /api/routine error:", err.message);
      return sendJSON(res, 500, { error: err.message, classes: [] });
    }
  }

  // ── API: run daily job ─────────────────────────
  if (parsedUrl.pathname === "/api/run" && req.method === "GET") {
    const secret = parsedUrl.searchParams.get("secret");
    if (CONFIG.cronSecret && secret !== CONFIG.cronSecret) {
      return sendJSON(res, 403, {
        success: false,
        error: "Forbidden: invalid secret",
      });
    }
    try {
      await dailyJob();
      return sendJSON(res, 200, { success: true, message: "Job executed" });
    } catch (err) {
      console.error("API /api/run error:", err.message);
      return sendJSON(res, 500, { success: false, error: err.message });
    }
  }

  // ── Legacy plain-text endpoints ────────────────
  if (parsedUrl.pathname === "/status" && req.method === "GET") {
    const credExists = fs.existsSync(path.join(__dirname, "credentials.json"));
    const envExists = fs.existsSync(path.join(__dirname, ".env"));
    const status = [
      `App: running`,
      `__dirname: ${__dirname}`,
      `.env file exists: ${envExists}`,
      `credentials.json exists: ${credExists}`,
      `SPREADSHEET_ID set: ${!!CONFIG.spreadsheetId}`,
      `WHATSAPP_TOKEN set: ${!!CONFIG.whatsappToken}`,
      `PHONE_NUMBER_ID set: ${!!CONFIG.phoneNumberId}`,
      `YOUR_PHONE set: ${!!CONFIG.recipientPhone}`,
      `OPENROUTER_API_KEY set: ${!!CONFIG.openRouterApiKey}`,
      `Cron schedule: ${CONFIG.cronSchedule}`,
      `Timezone: ${CONFIG.timezone}`,
    ].join("\n");
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(status);
  }

  if (parsedUrl.pathname === "/run" && req.method === "GET") {
    const secret = parsedUrl.searchParams.get("secret");
    if (CONFIG.cronSecret && secret !== CONFIG.cronSecret) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }
    try {
      await dailyJob();
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("Job executed");
    } catch (err) {
      console.error("Error running daily job:", err.message);
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("Error: " + err.message);
    }
  }

  // ── Fallback ───────────────────────────────────
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ══════════════════════  STARTUP  ═══════════════════════════
// cPanel Passenger support
const HAS_PASSENGER =
  typeof PhusionPassenger !== "undefined" &&
  typeof PhusionPassenger.configure === "function";

if (HAS_PASSENGER) {
  try {
    PhusionPassenger.configure({ autoInstall: false });
  } catch (err) {
    console.error("Passenger configure failed:", err.message);
  }
}

try {
  validateConfig();
  console.log("Config validated successfully.");
} catch (err) {
  console.error("Config validation failed:", err.message);
  console.error(
    "App will still start — /status endpoint available for debugging."
  );
}

if (RUN_ONCE_MODE) {
  dailyJob().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exitCode = 1;
  });
} else {
  try {
    startScheduler();
  } catch (err) {
    console.error("Scheduler failed:", err.message);
  }

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use. Set a different PORT or stop the existing process.`
      );
      return;
    }
    console.error("Server failed to start:", err.message);
  });

  // Listen — prefer Passenger; fallback to regular PORT mode for cPanel/node-app setups
  if (HAS_PASSENGER) {
    try {
      server.listen("passenger", () => {
        console.log("App started via Passenger.");
      });
    } catch (err) {
      console.error(
        "Passenger listen failed, falling back to PORT mode:",
        err.message
      );
      server.listen(PORT, "0.0.0.0", () => {
        console.log(`Server listening on port ${PORT} (fallback mode)`);
      });
    }
  } else {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server listening on port ${PORT}`);
    });
  }
}

module.exports = { dailyJob, validateConfig, CONFIG, startScheduler, server };
