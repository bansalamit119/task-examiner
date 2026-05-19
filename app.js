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
<meta name="viewport" content="width=device-width, initial-scale=1" />

<!-- OneSignal SDK -->
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

<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/css/materialize.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<title>Daily Tasks</title>

<style>
body { background:#f4f6f8; }
.container { max-width:600px; }
.success-box {
  background:#e8f5e9;
  padding:16px;
  border-radius:10px;
  text-align:center;
}
.motivation { margin-top:8px; color:#2e7d32; }
.milestone-card {
  display:none;
  background:#fff8e1;
  border-left:5px solid #ffc107;
  border-radius:8px;
  padding:16px;
  margin-top:12px;
  text-align:center;
}
.milestone-card h6 { color:#e65100; margin:6px 0; font-weight:bold; }
.milestone-card p { color:#5d4037; margin:4px 0; }
.heatmap-cell { aspect-ratio:1/1; border-radius:3px; min-height:18px; }
</style>
</head>

<body>
<div class="container">
  <h5 class="center-align">Daily Tasks ✅</h5>
  <p class="center-align grey-text">${new Date(today()).toDateString()}</p>
  <h6 class="center-align" id="streakInfo"></h6>

  <!-- MILESTONE CELEBRATION -->
  <div class="milestone-card" id="milestoneCard">
    <div style="font-size:2.2rem;" id="milestoneEmoji">🏆</div>
    <h6 id="milestoneLabel"></h6>
    <p id="milestoneMessage"></p>
  </div>

  <!-- ACTIVITY HEATMAP -->
  <div class="card" style="margin-top:12px;">
    <div class="card-content" style="padding-bottom:12px;">
      <h6 style="margin-bottom:8px;">Activity — Last 5 Weeks</h6>
      <div style="display:grid; grid-template-columns:repeat(7,1fr); gap:3px; margin-bottom:4px;">
        <span style="font-size:10px;color:#999;text-align:center;">Mon</span>
        <span style="font-size:10px;color:#999;text-align:center;">Tue</span>
        <span style="font-size:10px;color:#999;text-align:center;">Wed</span>
        <span style="font-size:10px;color:#999;text-align:center;">Thu</span>
        <span style="font-size:10px;color:#999;text-align:center;">Fri</span>
        <span style="font-size:10px;color:#999;text-align:center;">Sat</span>
        <span style="font-size:10px;color:#999;text-align:center;">Sun</span>
      </div>
      <div id="heatmapGrid" style="display:grid; grid-template-columns:repeat(7,1fr); gap:3px;"></div>
      <div style="display:flex; align-items:center; gap:5px; margin-top:8px; font-size:11px; color:#9e9e9e;">
        <span>Less</span>
        <div style="width:13px;height:13px;background:#e0e0e0;border-radius:2px;"></div>
        <div style="width:13px;height:13px;background:#c6e48b;border-radius:2px;"></div>
        <div style="width:13px;height:13px;background:#7bc96f;border-radius:2px;"></div>
        <div style="width:13px;height:13px;background:#239a3b;border-radius:2px;"></div>
        <span>More</span>
      </div>
    </div>
  </div>

    <div class="card" id="weeklySummaryCard" style="display:none; margin-top:12px;">
    <div class="card" id="taskFrequencyCard" style="display:none; margin-top:12px;">
      <div class="card-content">
        <h6>Most Consistent Tasks</h6>
        <ul id="taskFrequencyList" class="browser-default"></ul>
      </div>
    </div>

    <div class="card-content">
      <h6>This Week</h6>
      <p id="weeklyText" style="white-space:pre-line;"></p>
      <div class="motivation" id="weeklyMotivation"></div>
    </div>
  </div>

  ${
    todayDone
      ? `
      <div class="success-box">
        <h6>Okay, done for the day ✅</h6>
        <div class="motivation">
          ${getMotivationMessage()}
        </div>
      </div>
      `
      : `
      <div class="card">
        <div class="card-content">
          <form id="taskForm">
            <ul class="collection">
              ${tasks
                .map(
                  t => `
                <li class="collection-item">
                  <label>
                    <input type="checkbox" value="${t.name}" />
                    <span>${t.name}</span>
                  </label>
                </li>`
                )
                .join("")}
            </ul>
            <div class="input-field">
              <input id="note" type="text" placeholder="Any note for today? (optional)">
            </div>

            <button class="btn green full-width">Submit Today</button>
          </form>
        </div>
      </div>
      `
  }

  <div class="center-align" style="margin-top:16px;">
    <a class="btn modal-trigger blue" href="#addTaskModal">Add Task</a>
    <a class="btn modal-trigger grey" href="#historyModal">History</a>
  </div>
</div>

<!-- ADD TASK MODAL -->
<div id="addTaskModal" class="modal">
  <div class="modal-content">
    <h6>Add New Task</h6>
    <form method="POST" action="/add-task">
      <input name="name" placeholder="Task name" required />
      <button class="btn green">Save</button>
    </form>
  </div>
</div>

<!-- HISTORY MODAL -->
<div id="historyModal" class="modal">
  <div class="modal-content">
    <h6>Total Points</h6>
    <canvas id="pointsChart"></canvas>
    <ul class="collection" id="historyList"></ul>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/js/materialize.min.js"></script>

<script>
document.addEventListener("DOMContentLoaded",()=> {
  M.Modal.init(document.querySelectorAll(".modal"));
});

fetch("/data").then(r => r.json()).then(d => {
  document.getElementById("streakInfo").innerText =
    "🔥 Current Streak: " + d.currentStreak +
    " days | 🏆 Longest: " + d.longestStreak + " days";

  const history = document.getElementById("historyList");
  d.days.forEach(day => {
    history.innerHTML +=
      "<li class='collection-item'>" +
        "<b>" + new Date(day.date).toDateString() + "</b>" +
        "<span class='right'>" + day.points + " pts</span>" +
        "<div class='grey-text' style='font-size:13px;'>" +
          "Tasks: " + day.completedTasks.join(', ') +
        "</div>" +
        "<div class='grey-text' style='font-size:13px;'>" +
          "Reflection: " + (day.note || "N/A") +
        "</div>" +
      "</li>";
  });

  new Chart(document.getElementById("pointsChart"), {
    type: "line",
    data: {
      labels: d.days.map(x => new Date(x.date).toDateString()),
      datasets: [{
        data: d.days.map(x => x.points),
        label: "Daily Points"
      }]
    }
  });

  if (d.weeklySummary) {
    document.getElementById("weeklySummaryCard").style.display = "block";

    document.getElementById("weeklyText").innerText =
      "✔ " + d.weeklySummary.completedDays + " / 7 days completed\\n" +
      "⭐ Total points: " + d.weeklySummary.totalPoints + "\\n" +
      "📊 Avg per day: " + d.weeklySummary.avgPoints + "\\n" +
      "🔥 Best day: " + d.weeklySummary.bestDay;

    document.getElementById("weeklyMotivation").innerText =
      d.weeklyMotivation;
  }

  if (d.taskFrequency && d.taskFrequency.length) {
    document.getElementById("taskFrequencyCard").style.display = "block";
    const list = document.getElementById("taskFrequencyList");

    d.taskFrequency.forEach(item => {
      const li = document.createElement("li");
      li.innerText = item.task + " — " + item.count + " days";
      list.appendChild(li);
    });
  }

  // Milestone celebration
  if (d.milestone) {
    const card = document.getElementById("milestoneCard");
    card.style.display = "block";
    document.getElementById("milestoneLabel").innerText = "🎉 " + d.milestone.label + " Achieved!";
    document.getElementById("milestoneMessage").innerText = d.milestone.message;
  }

  // Activity heatmap
  (function buildHeatmap() {
    const pointsMap = {};
    d.days.forEach(function(day) { pointsMap[day.date] = day.points; });

    const todayDate = new Date(d.today + "T00:00:00");
    const dayOfWeekMon = (todayDate.getDay() + 6) % 7; // 0=Mon … 6=Sun

    const startDate = new Date(todayDate);
    startDate.setDate(startDate.getDate() - dayOfWeekMon - 28);

    const grid = document.getElementById("heatmapGrid");

    for (let i = 0; i < 35; i++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + i);
      const dateStr = date.toLocaleDateString("en-CA");
      const isFuture = dateStr > d.today;
      const pts = pointsMap[dateStr];

      const cell = document.createElement("div");
      cell.className = "heatmap-cell";
      cell.title = dateStr + (pts !== undefined
        ? " — " + pts + " pts"
        : isFuture ? "" : " — missed");

      if (isFuture) {
        cell.style.background = "transparent";
      } else if (pts === undefined) {
        cell.style.background = "#e0e0e0";
      } else if (pts <= 2) {
        cell.style.background = "#c6e48b";
      } else if (pts <= 4) {
        cell.style.background = "#7bc96f";
      } else {
        cell.style.background = "#239a3b";
      }

      grid.appendChild(cell);
    }
  })();

});


${
  todayDone
    ? ""
    : `
document.getElementById("taskForm").onsubmit = async e=>{
  e.preventDefault();
  const checked = [...document.querySelectorAll("input[type=checkbox]:checked")];
  if(!checked.length){
    M.toast({html:"Select at least one task"});
    return;
  }

  const res = await fetch("/submit",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ tasks: checked.map(c=>c.value) , note: document.getElementById("note").value })
  });

  if(await res.text()==="OK") location.reload();
};`
}
</script>
</body>
</html>`);
});

/* ===================== START ===================== */

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 App running")
);
