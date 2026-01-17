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

app.get("/health", (_, res) => res.send("OK"));

app.get("/data", async (_, res) => {
  const tasks = await Task.find().sort({ createdAt: 1 });
  const days = await Day.find().sort({ date: 1 });
  res.json({ tasks, days, today: today() });
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
</style>
</head>

<body>
<div class="container">
  <h5 class="center-align">Daily Tasks ✅</h5>
  <p class="center-align grey-text">${new Date(today()).toDateString()}</p>

  ${
    todayDone
      ? `
      <div class="success-box">
        <h6>Okay, done for the day ✅</h6>
        <div class="motivation">
          Consistency beats motivation. See you tomorrow 🔥
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

fetch("/data").then(r=>r.json()).then(d=>{
  const history = document.getElementById("historyList");
  d.days.forEach(day=>{
    history.innerHTML += \`
      <li class="collection-item">
        <b>\${new Date(day.date).toDateString()}</b>
        <span class="right">\${day.points} pts</span>
        <div class="grey-text" style="font-size:13px;">
          Tasks: \${day.completedTasks.join(", ")}
        </div>
        <div class="grey-text" style="font-size:13px;">
          Reflection: \${day.note || "N/A"}
        </div>
      </li>\`;
  });

  new Chart(document.getElementById("pointsChart"),{
    type:"line",
    data:{
      labels:d.days.map(x=>new Date(x.date).toDateString()),
      datasets:[{ data:d.days.map(x=>x.points), label:"Daily Points" }]
    }
  });
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
