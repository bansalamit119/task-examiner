require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ===================== SERVE ONESIGNAL FILES FROM ROOT ===================== */
// This is REQUIRED for OneSignal web push
app.use(express.static(path.join(__dirname)));

/* ===================== DB ===================== */

mongoose.set("bufferCommands", false);

mongoose
  .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB connection failed");
    console.error(err.message);
    process.exit(1);
  });

const TaskSchema = new mongoose.Schema({
  name: String,
  createdAt: { type: Date, default: Date.now }
});

const DaySchema = new mongoose.Schema({
  date: String,
  completedTasks: [String],
  points: Number,
  note: String
});

const Task = mongoose.model("Task", TaskSchema);
const Day = mongoose.model("Day", DaySchema);

/* ===================== HELPERS ===================== */

const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const getCurrentStreak = (days) => {
  let streak = 0;
  let cursor = new Date(today());
  const dateSet = new Set(days.map(d => d.date));

  while (dateSet.has(cursor.toLocaleDateString("en-CA"))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
};

const getLongestStreak = (days) => {
  if (!days.length) return 0;

  const sorted = days
    .map(d => new Date(d.date))
    .sort((a, b) => a - b);

  let longest = 1;
  let current = 1;

  for (let i = 1; i < sorted.length; i++) {
    const diff =
      (sorted[i] - sorted[i - 1]) / (1000 * 60 * 60 * 24);

    if (diff === 1) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 1;
    }
  }

  return longest;
};

const getLast7Dates = () => {
  const dates = [];
  const cursor = new Date(today());

  for (let i = 0; i < 7; i++) {
    dates.push(cursor.toLocaleDateString("en-CA"));
    cursor.setDate(cursor.getDate() - 1);
  }
  return dates;
};

const getWeeklySummary = (days) => {
  const last7 = getLast7Dates();
  const map = new Map(days.map(d => [d.date, d.points]));

  let completedDays = 0;
  let totalPoints = 0;
  let bestDayPoints = 0;
  let bestDayDate = null;

  last7.forEach(date => {
    const pts = map.get(date) || 0;
    if (pts > 0) completedDays++;
    totalPoints += pts;

    if (pts > bestDayPoints) {
      bestDayPoints = pts;
      bestDayDate = date;
    }
  });

  return {
    completedDays,
    totalPoints,
    avgPoints: Number((totalPoints / 7).toFixed(2)),
    bestDay: bestDayDate
      ? new Date(bestDayDate).toDateString()
      : "N/A"
  };
};

const getWeeklyMotivation = (avg) => {
  const dayOfWeek = new Date().getDay(); 
  // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  // Early week (Mon–Tue)
  if (dayOfWeek <= 2) {
    if (avg > 0)
      return "Good start. Early consistency sets the tone 🌱";
    return "The week just started. Begin calmly and build momentum.";
  }

  // Mid week (Wed–Thu)
  if (dayOfWeek <= 4) {
    if (avg >= 3)
      return "Strong mid-week rhythm. Stay steady 💪";
    if (avg > 0)
      return "Progress is forming. Keep showing up.";
    return "There’s still plenty of time to shape this week.";
  }

  // Late week (Fri–Sun)
  if (avg >= 4)
    return "Strong week. You’re building real momentum 💪";
  if (avg >= 2)
    return "Steady progress beats intensity. Keep going 🌱";
  if (avg > 0)
    return "Even imperfect weeks move you forward.";
  return "A reset week is not failure — it’s information.";
};



const getTaskFrequency = (days, limit = 5) => {
  const freq = {};

  days.forEach(day => {
    (day.completedTasks || []).forEach(task => {
      freq[task] = (freq[task] || 0) + 1;
    });
  });

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([task, count]) => ({ task, count }));
};

const getMotivationMessage = () => {
  const index = Math.floor(Math.random() * motivationMessages.length);
  return motivationMessages[index];
};

const getMilestone = (streak) => {
  const milestones = {
    7:  { label: "7-Day Streak", message: "One week in. The decision is real. Keep going. 🌱" },
    14: { label: "14-Day Streak", message: "Two weeks of showing up. The habit is forming. 💪" },
    21: { label: "21-Day Streak", message: "21 days — you're breaking the old pattern. 🔥" },
    30: { label: "1 Month Streak", message: "One month of discipline. This is who you're becoming. 🏆" },
    60: { label: "2 Month Streak", message: "60 days of showing up. You are proof it's possible. ⭐" },
    90: { label: "90-Day Streak", message: "90 days. You are a different person than when you started. 🎯" }
  };
  return milestones[streak] || null;
};

/* ===================== EMAIL (OPTIONAL) ===================== */

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/* ===================== CRONS ===================== */

// 🔔 OneSignal Push Reminder – 10:30 PM IST
cron.schedule(
  "30 22 * * *",
  async () => {
    try {
      await axios.post(
        "https://onesignal.com/api/v1/notifications",
        {
          app_id: process.env.ONESIGNAL_APP_ID,
          included_segments: ["Subscribed Users"],
          headings: { en: "Daily Task Reminder" },
          contents: { en: "Don’t forget to submit your tasks today 💪" }
        },
        {
          headers: {
            Authorization: `Basic ${process.env.ONESIGNAL_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );
    } catch (err) {
      console.error("❌ OneSignal push failed");
    }
  },
  { timezone: "Asia/Kolkata" }
);

// Keep Render awake (best effort)
cron.schedule("*/10 * * * *", async () => {
  try {
    await axios.get(`${process.env.BASE_URL}/health`);
  } catch {}
});

/* ===================== ROUTES ===================== */

app.get("/health", (_, res) => res.send(true));


setInterval(() => {
  fetch(`${process.env.BASE_URL}/health`).catch(() => {});
}, 30000); // Prevent Render.com from idling the app

app.get("/data", async (_, res) => {
  const tasks = await Task.find().sort({ createdAt: 1 });
  const days = await Day.find().sort({ date: 1 });
  const weeklySummary = getWeeklySummary(days);
  const taskFrequency = getTaskFrequency(days,3);
  const currentStreak = getCurrentStreak(days);
  res.json({
    tasks,
    days,
    today: today(),
    currentStreak,
    longestStreak: getLongestStreak(days),
    weeklySummary,
    taskFrequency,
    weeklyMotivation: getWeeklyMotivation(weeklySummary.avgPoints),
    milestone: getMilestone(currentStreak)
  });
});

app.post("/add-task", async (req, res) => {
  if (!req.body.name) return res.redirect("/");
  await Task.create({ name: req.body.name });
  res.redirect("/");
});

app.post("/submit", async (req, res) => {
  const existing = await Day.findOne({ date: today() });
  if (existing) return res.send("ALREADY_DONE");

  const completed = req.body.tasks || [];
  if (!completed.length) return res.status(400).send("NO_TASKS_SELECTED");

  console.log('req.body.note' , req.body.note);
  await Day.create({
    date: today(),
    completedTasks: completed,
    points: completed.length,
    note: req.body.note || ""
  });

  res.send("OK");
});

/* ===================== UI ===================== */

const motivationMessages = [
  // Core habit & discipline
  "Consistency beats motivation. See you tomorrow 🔥",
  "Small steps every day lead to big results 💪",
  "You showed up today. That’s what matters 👏",
  "Progress over perfection. Keep moving ✨",

  // Osho-inspired (awareness & inner fire)
  "Discipline is not force — it’s love for your future self 🌱",
  "When you act consciously, even small acts become powerful 🔥",
  "Don’t wait for motivation. Awareness itself creates energy.",
  "Your daily actions are your meditation in motion 🧘",

  // Buddha-inspired (right effort & persistence)
  "Drop by drop, the pot is filled. Continue calmly 🌊",
  "Right effort today makes tomorrow lighter.",
  "Peace comes from steady practice, not sudden bursts.",
  "Walk the path patiently — every step counts ☸️",

  // Nietzsche-inspired (will & becoming)
  "Become stronger through repetition — that is the way.",
  "He who has a reason to continue will endure the day.",
  "Comfort weakens the will. Discipline sharpens it ⚔️",
  "You are becoming — do not interrupt the process.",

  // 50 Cent–inspired (grit & hunger)
  "Stay hungry. Comfort kills growth.",
  "Discipline creates options. Laziness closes doors.",
  "Do the work quietly. Results will make noise.",
  "No excuses today. That’s how momentum is built.",

  // Blend / modern
  "You didn’t rely on mood today — you relied on discipline.",
  "Show up again tomorrow. That’s how identity is built.",
  "One focused day beats ten emotional plans.",
  "You’re training your mind more than your body today 💯"
];


app.get("/", async (_, res) => {
  const todayDone = await Day.findOne({ date: today() });
  const tasks = todayDone ? [] : await Task.find().sort({ createdAt: 1 });

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="theme-color" content="#f2f2f7" />

<script src="https://cdn.onesignal.com/sdks/OneSignalSDK.js" async></script>
<script>
window.OneSignal = window.OneSignal || [];
OneSignal.push(function() {
  OneSignal.init({
    appId: "${process.env.ONESIGNAL_APP_ID}",
    serviceWorkerPath: "OneSignalSDKWorker.js",
    serviceWorkerUpdaterPath: "OneSignalSDKUpdaterWorker.js",
    notifyButton: { enable: true }
  });
});
</script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<title>Daily Tasks</title>
<style>
:root {
  --bg: #f2f2f7;
  --card: #ffffff;
  --green: #34c759;
  --green-dk: #248a3d;
  --blue: #007aff;
  --amber: #ff9500;
  --text: #1c1c1e;
  --text2: #3c3c43;
  --text3: #8e8e93;
  --sep: #e5e5ea;
  --r: 16px;
  --safe-top: env(safe-area-inset-top, 44px);
  --safe-bottom: env(safe-area-inset-bottom, 34px);
}
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html { background: var(--bg); }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  background: var(--bg);
  color: var(--text);
  max-width: 430px;
  margin: 0 auto;
  padding-bottom: calc(72px + var(--safe-bottom));
}
/* HEADER */
.app-header {
  position: sticky; top: 0; z-index: 100;
  padding: calc(var(--safe-top) + 6px) 20px 12px;
  background: #f2f2f7;
  border-bottom: 0.5px solid var(--sep);
}
.app-header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.4px; }
.app-header p  { font-size: 13px; color: var(--text3); margin-top: 1px; }
/* CONTENT */
.content { padding: 16px 16px 0; }
/* SECTION LABEL */
.sec-label {
  font-size: 13px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.3px;
  color: var(--text3); padding: 0 4px 6px; margin-top: 4px;
}
/* CARD */
.card { background: var(--card); border-radius: var(--r); margin-bottom: 12px; overflow: hidden; }
/* STREAK */
.streak-row { display: flex; justify-content: space-around; padding: 20px 16px; }
.streak-item { text-align: center; }
.streak-num { font-size: 44px; font-weight: 800; letter-spacing: -2px; line-height: 1; }
.streak-num.fire   { color: var(--amber); }
.streak-num.trophy { color: #5856d6; }
.streak-lbl { font-size: 12px; color: var(--text3); margin-top: 4px; font-weight: 500; }
/* MILESTONE */
.milestone-card { display: none; }
.milestone-inner {
  background: linear-gradient(135deg,#fff8e1,#fffde7);
  border-left: 4px solid var(--amber);
  padding: 18px 20px; text-align: center;
}
.milestone-emoji { font-size: 2.4rem; display: block; margin-bottom: 6px; }
.milestone-title { font-size: 17px; font-weight: 700; color: #b25000; }
.milestone-msg   { font-size: 14px; color: #795548; margin-top: 4px; line-height: 1.45; }
/* TASK ROWS */
.task-row {
  display: flex; align-items: center; padding: 14px 16px; gap: 14px;
  cursor: pointer; transition: background 0.12s;
  -webkit-user-select: none; user-select: none;
  touch-action: manipulation;
}
.task-row:not(:last-of-type) { border-bottom: 0.5px solid var(--sep); }
.task-row:active { background: #f2f2f7; }
.check-circle {
  width: 27px; height: 27px; border-radius: 50%;
  border: 2px solid #c7c7cc; background: #fff; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.22s cubic-bezier(0.34,1.56,0.64,1);
  font-size: 14px; color: transparent;
}
.task-row.checked .check-circle {
  background: var(--green); border-color: var(--green);
  color: white; transform: scale(1.12);
}
.task-name { font-size: 16px; flex: 1; }
.task-row.checked .task-name { color: var(--text3); text-decoration: line-through; }
/* NOTE */
.note-wrap { padding: 11px 16px; border-top: 0.5px solid var(--sep); }
.note-input {
  width: 100%; border: none; outline: none;
  font-size: 15px; font-family: inherit;
  color: var(--text); background: transparent; padding: 2px 0;
}
.note-input::placeholder { color: var(--text3); }
/* SUBMIT */
.submit-btn {
  display: block; width: calc(100% - 32px);
  margin: 0 16px 12px; padding: 15px;
  background: var(--green); color: white; border: none;
  border-radius: 14px; font-size: 17px; font-weight: 600;
  font-family: inherit; cursor: pointer;
  transition: transform 0.1s, opacity 0.1s;
  touch-action: manipulation;
}
.submit-btn:active { transform: scale(0.97); opacity: 0.85; }
/* SUCCESS */
.success-inner { text-align: center; padding: 28px 20px; }
.success-icon  { font-size: 3.2rem; display: block; margin-bottom: 10px; }
.success-title { font-size: 18px; font-weight: 700; color: var(--green-dk); }
.success-msg   { font-size: 14px; color: var(--text2); margin-top: 8px; line-height: 1.5; }
.success-tasks { font-size: 13px; color: var(--text3); margin-top: 10px; }
/* WEEKLY STATS GRID */
.stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--sep); }
.stat-cell { background: var(--card); padding: 14px 16px; }
.stat-val  { font-size: 22px; font-weight: 700; }
.stat-key  { font-size: 12px; color: var(--text3); margin-top: 2px; }
.week-motivation { padding: 12px 16px; font-size: 14px; color: var(--text2); border-top: 0.5px solid var(--sep); font-style: italic; }
/* HEATMAP */
.heatmap-day-labels {
  display: grid; grid-template-columns: repeat(7,1fr); gap: 3px; padding: 12px 16px 4px;
}
.heatmap-day-labels span { font-size: 10px; color: var(--text3); text-align: center; font-weight: 500; }
.heatmap-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 3px; padding: 0 16px 10px; }
.heatmap-cell { aspect-ratio: 1/1; border-radius: 4px; min-height: 20px; }
.heatmap-legend {
  display: flex; align-items: center; gap: 5px;
  padding: 0 16px 14px; font-size: 11px; color: var(--text3);
}
.legend-dot { width: 13px; height: 13px; border-radius: 3px; }
/* TASK FREQUENCY BARS */
.freq-row {
  display: flex; align-items: center;
  padding: 12px 16px; gap: 12px;
}
.freq-row:not(:last-child) { border-bottom: 0.5px solid var(--sep); }
.freq-name  { font-size: 15px; flex: 1; }
.freq-bar-wrap { width: 80px; height: 6px; background: var(--sep); border-radius: 3px; overflow: hidden; }
.freq-bar   { height: 100%; background: var(--green); border-radius: 3px; width: 0; transition: width 0.7s cubic-bezier(0.34,1.1,0.64,1); }
.freq-count { font-size: 13px; color: var(--text3); font-weight: 600; min-width: 28px; text-align: right; }
/* BOTTOM NAV */
.bottom-nav {
  position: fixed; bottom: 0; left: 0; right: 0;
  height: calc(58px + var(--safe-bottom));
  background: #ffffff;
  border-top: 0.5px solid var(--sep);
  display: flex; justify-content: space-around; align-items: flex-start;
  padding-top: 8px; z-index: 200;
}
.nav-btn {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  background: none; border: none; cursor: pointer; padding: 0 24px;
  font-family: inherit; transition: opacity 0.1s;
  -webkit-appearance: none; appearance: none;
  touch-action: manipulation;
}
.nav-btn:active { opacity: 0.45; }
.nav-icon  { font-size: 23px; }
.nav-label { font-size: 10px; font-weight: 500; color: var(--text3); }
/* OVERLAY + BOTTOM SHEET */
.overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,0.38); z-index: 300;
  opacity: 0; transition: opacity 0.2s ease;
}
.overlay.open { opacity: 1; }
.sheet {
  display: none; position: fixed;
  bottom: 0; left: 0; right: 0; max-height: 86vh;
  background: var(--card); border-radius: 20px 20px 0 0;
  z-index: 400; overflow: hidden;
  padding-bottom: var(--safe-bottom);
  transform: translateY(100%);
  transition: transform 0.32s cubic-bezier(0.34,1.15,0.64,1);
}
.sheet.open { transform: translateY(0); }
.sheet-handle { width: 36px; height: 5px; background: var(--sep); border-radius: 3px; margin: 10px auto 0; }
.sheet-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 20px 12px; border-bottom: 0.5px solid var(--sep);
}
.sheet-title { font-size: 18px; font-weight: 700; }
.sheet-close {
  background: var(--bg); border: none; border-radius: 50%;
  width: 30px; height: 30px; font-size: 15px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; color: var(--text3);
  touch-action: manipulation;
}
.sheet-body { overflow-y: auto; max-height: calc(86vh - 76px); padding: 16px 20px; }
/* HISTORY LIST */
.history-item { padding: 13px 0; border-bottom: 0.5px solid var(--sep); }
.history-item:last-child { border-bottom: none; }
.history-top  { display: flex; justify-content: space-between; align-items: baseline; }
.history-date { font-size: 15px; font-weight: 600; }
.history-pts  { font-size: 13px; font-weight: 700; color: var(--green-dk); }
.history-tasks { font-size: 13px; color: var(--text3); margin-top: 3px; }
.history-note  { font-size: 13px; color: var(--text2); margin-top: 3px; font-style: italic; }
/* ADD TASK FORM */
.add-input {
  width: 100%; padding: 14px; font-size: 16px; font-family: inherit;
  border: 1.5px solid var(--sep); border-radius: 12px; outline: none;
  margin-bottom: 14px; background: var(--bg);
  transition: border-color 0.18s;
}
.add-input:focus { border-color: var(--blue); }
.add-btn {
  width: 100%; padding: 15px; background: var(--blue); color: white;
  border: none; border-radius: 14px; font-size: 17px; font-weight: 600;
  font-family: inherit; cursor: pointer;
  transition: opacity 0.1s, transform 0.1s;
}
.add-btn:active { opacity: 0.8; transform: scale(0.98); }
</style>
</head>
<body>

<!-- STICKY HEADER -->
<div class="app-header">
  <h1>Daily Tasks</h1>
  <p>${new Date().toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", timeZone:"Asia/Kolkata" })}</p>
</div>

<div class="content">

  <!-- STREAK -->
  <p class="sec-label">Streaks</p>
  <div class="card">
    <div class="streak-row">
      <div class="streak-item">
        <div class="streak-num fire" id="currentStreak">—</div>
        <div class="streak-lbl">🔥 Current</div>
      </div>
      <div style="width:1px;background:var(--sep);"></div>
      <div class="streak-item">
        <div class="streak-num trophy" id="longestStreak">—</div>
        <div class="streak-lbl">🏆 Longest</div>
      </div>
    </div>
  </div>

  <!-- MILESTONE -->
  <div class="card milestone-card" id="milestoneCard">
    <div class="milestone-inner">
      <span class="milestone-emoji">🏆</span>
      <div class="milestone-title" id="milestoneLabel"></div>
      <div class="milestone-msg"   id="milestoneMessage"></div>
    </div>
  </div>

  <!-- ACTIVITY HEATMAP -->
  <p class="sec-label">Activity</p>
  <div class="card">
    <div class="heatmap-day-labels">
      <span>M</span><span>T</span><span>W</span><span>T</span>
      <span>F</span><span>S</span><span>S</span>
    </div>
    <div class="heatmap-grid" id="heatmapGrid"></div>
    <div class="heatmap-legend">
      <span>Less</span>
      <div class="legend-dot" style="background:#e0e0e0;"></div>
      <div class="legend-dot" style="background:#c6e48b;"></div>
      <div class="legend-dot" style="background:#7bc96f;"></div>
      <div class="legend-dot" style="background:#239a3b;"></div>
      <span>More</span>
    </div>
  </div>

  <!-- TODAY: TASK FORM or SUCCESS -->
  <p class="sec-label">Today</p>
  ${todayDone
    ? `<div class="card">
    <div class="success-inner">
      <span class="success-icon">✅</span>
      <div class="success-title">Done for today</div>
      <div class="success-msg">${getMotivationMessage()}</div>
      <div class="success-tasks">${todayDone.completedTasks.join("  ·  ")}</div>
    </div>
  </div>`
    : `<div class="card" id="taskCard">
    ${tasks.map(t => `<div class="task-row" data-task="${t.name}" onclick="toggleTask(this)">
      <div class="check-circle">✓</div>
      <div class="task-name">${t.name}</div>
    </div>`).join("")}
    <div class="note-wrap">
      <input class="note-input" id="noteInput" type="text" placeholder="Any note for today? (optional)" />
    </div>
  </div>
  <button class="submit-btn" id="submitBtn" onclick="submitTasks()">Submit Today</button>`
  }

  <!-- WEEKLY SUMMARY -->
  <p class="sec-label" id="weekLabel" style="display:none;">This Week</p>
  <div class="card" id="weeklyCard" style="display:none;">
    <div class="stat-grid" id="statGrid"></div>
    <div class="week-motivation" id="weekMotivation"></div>
  </div>

  <!-- MOST CONSISTENT -->
  <p class="sec-label" id="freqLabel" style="display:none;">Most Consistent</p>
  <div class="card" id="freqCard" style="display:none;"></div>

</div><!-- /content -->

<!-- BOTTOM NAV -->
<nav class="bottom-nav">
  <button class="nav-btn" onclick="openSheet('historySheet')">
    <span class="nav-icon">📅</span>
    <span class="nav-label">History</span>
  </button>
  <button class="nav-btn" onclick="openSheet('addSheet')">
    <span class="nav-icon" style="font-size:30px;color:var(--green);">＋</span>
    <span class="nav-label">Add Task</span>
  </button>
  <button class="nav-btn" onclick="openSheet('historySheet')">
    <span class="nav-icon">📊</span>
    <span class="nav-label">Stats</span>
  </button>
</nav>

<!-- OVERLAY -->
<div class="overlay" id="overlay" onclick="closeSheets()"></div>

<!-- HISTORY SHEET -->
<div class="sheet" id="historySheet">
  <div class="sheet-handle"></div>
  <div class="sheet-header">
    <span class="sheet-title">History</span>
    <button class="sheet-close" onclick="closeSheets()">✕</button>
  </div>
  <div class="sheet-body">
    <canvas id="pointsChart" style="margin-bottom:20px;"></canvas>
    <div id="historyList"></div>
  </div>
</div>

<!-- ADD TASK SHEET -->
<div class="sheet" id="addSheet">
  <div class="sheet-handle"></div>
  <div class="sheet-header">
    <span class="sheet-title">New Task</span>
    <button class="sheet-close" onclick="closeSheets()">✕</button>
  </div>
  <div class="sheet-body">
    <form method="POST" action="/add-task">
      <input class="add-input" name="name" placeholder="e.g. Morning walk" required autocomplete="off" />
      <button type="submit" class="add-btn">Save Task</button>
    </form>
  </div>
</div>

<script>
function openSheet(id) {
  var overlay = document.getElementById("overlay");
  var sheet   = document.getElementById(id);
  overlay.style.display = "block";
  sheet.style.display   = "block";
  sheet.offsetHeight; // force reflow so transition fires from translateY(100%)
  overlay.classList.add("open");
  sheet.classList.add("open");
}
function closeSheets() {
  var overlay = document.getElementById("overlay");
  overlay.classList.remove("open");
  ["historySheet","addSheet"].forEach(function(id) {
    var el = document.getElementById(id);
    el.classList.remove("open");
    setTimeout(function() { el.style.display = "none"; }, 340);
  });
  setTimeout(function() { overlay.style.display = "none"; }, 220);
}

function toggleTask(row) {
  row.classList.toggle("checked");
}

async function submitTasks() {
  var checked = document.querySelectorAll(".task-row.checked");
  var btn = document.getElementById("submitBtn");
  if (!checked.length) {
    btn.style.background = "#ff3b30";
    btn.innerText = "Select at least one task";
    setTimeout(function() {
      btn.style.background = "";
      btn.innerText = "Submit Today";
    }, 1600);
    return;
  }
  var tasks = Array.from(checked).map(function(r) { return r.dataset.task; });
  var note  = document.getElementById("noteInput").value;
  btn.disabled = true; btn.innerText = "Saving…";
  var res = await fetch("/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tasks: tasks, note: note })
  });
  if (await res.text() === "OK") location.reload();
}

fetch("/data").then(function(r) { return r.json(); }).then(function(d) {
  document.getElementById("currentStreak").innerText = d.currentStreak;
  document.getElementById("longestStreak").innerText = d.longestStreak;

  // Milestone
  if (d.milestone) {
    var mc = document.getElementById("milestoneCard");
    mc.style.display = "block";
    document.getElementById("milestoneLabel").innerText  = "🎉 " + d.milestone.label + " Achieved!";
    document.getElementById("milestoneMessage").innerText = d.milestone.message;
  }

  // Heatmap
  (function() {
    var pm = {};
    d.days.forEach(function(day) { pm[day.date] = day.points; });
    var td = new Date(d.today + "T00:00:00");
    var dow = (td.getDay() + 6) % 7;
    var start = new Date(td);
    start.setDate(start.getDate() - dow - 28);
    var grid = document.getElementById("heatmapGrid");
    for (var i = 0; i < 35; i++) {
      var date = new Date(start);
      date.setDate(start.getDate() + i);
      var ds = date.toLocaleDateString("en-CA");
      var isFuture = ds > d.today;
      var pts = pm[ds];
      var cell = document.createElement("div");
      cell.className = "heatmap-cell";
      cell.title = ds + (pts !== undefined ? " — " + pts + " pts" : isFuture ? "" : " — missed");
      if (isFuture)          cell.style.background = "transparent";
      else if (pts === undefined) cell.style.background = "#e0e0e0";
      else if (pts <= 2)     cell.style.background = "#c6e48b";
      else if (pts <= 4)     cell.style.background = "#7bc96f";
      else                   cell.style.background = "#239a3b";
      grid.appendChild(cell);
    }
  })();

  // Weekly summary
  if (d.weeklySummary) {
    document.getElementById("weekLabel").style.display = "block";
    document.getElementById("weeklyCard").style.display = "block";
    var stats = [
      { val: d.weeklySummary.completedDays + "/7", key: "Days Done" },
      { val: d.weeklySummary.totalPoints,           key: "Total Points" },
      { val: d.weeklySummary.avgPoints,             key: "Avg / Day" },
      { val: d.weeklySummary.bestDay.split(" ").slice(0,3).join(" "), key: "Best Day" }
    ];
    var sg = document.getElementById("statGrid");
    stats.forEach(function(s) {
      sg.innerHTML += "<div class='stat-cell'><div class='stat-val'>" + s.val +
        "</div><div class='stat-key'>" + s.key + "</div></div>";
    });
    document.getElementById("weekMotivation").innerText = d.weeklyMotivation;
  }

  // Task frequency
  if (d.taskFrequency && d.taskFrequency.length) {
    document.getElementById("freqLabel").style.display = "block";
    var fc = document.getElementById("freqCard");
    fc.style.display = "block";
    var max = d.taskFrequency[0].count;
    d.taskFrequency.forEach(function(item) {
      var pct = Math.round((item.count / max) * 100);
      fc.innerHTML += "<div class='freq-row'>" +
        "<div class='freq-name'>" + item.task + "</div>" +
        "<div class='freq-bar-wrap'><div class='freq-bar' data-pct='" + pct + "'></div></div>" +
        "<div class='freq-count'>" + item.count + "d</div>" +
        "</div>";
    });
    setTimeout(function() {
      document.querySelectorAll(".freq-bar").forEach(function(b) {
        b.style.width = b.dataset.pct + "%";
      });
    }, 120);
  }

  // History list (newest first)
  d.days.slice().reverse().forEach(function(day) {
    document.getElementById("historyList").innerHTML +=
      "<div class='history-item'>" +
        "<div class='history-top'>" +
          "<span class='history-date'>" + new Date(day.date).toDateString() + "</span>" +
          "<span class='history-pts'>" + day.points + " pts</span>" +
        "</div>" +
        "<div class='history-tasks'>" + day.completedTasks.join("  ·  ") + "</div>" +
        (day.note ? "<div class='history-note'>\"" + day.note + "\"</div>" : "") +
      "</div>";
  });

  // Points chart
  new Chart(document.getElementById("pointsChart"), {
    type: "line",
    data: {
      labels: d.days.map(function(x) { return x.date.slice(5); }),
      datasets: [{
        data: d.days.map(function(x) { return x.points; }),
        label: "Points", fill: true, tension: 0.4,
        borderColor: "#34c759", backgroundColor: "rgba(52,199,89,0.1)",
        pointRadius: 3, pointBackgroundColor: "#34c759"
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { beginAtZero: true, ticks: { stepSize: 1 } } }
    }
  });
});
</script>
</body>
</html>`);
});

/* ===================== START ===================== */

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 App running")
);
