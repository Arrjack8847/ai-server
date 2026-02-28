import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "1mb" }));

/* =========================================================
   CORS (Allow localhost + Vercel)
========================================================= */

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (
        origin.includes("localhost") ||
        origin.includes("127.0.0.1") ||
        origin.includes(".vercel.app")
      ) {
        return callback(null, true);
      }

      return callback(new Error("CORS blocked: " + origin), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/* =========================================================
   ENV CHECK
========================================================= */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
if (!FIREBASE_SERVICE_ACCOUNT_JSON)
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");

/* =========================================================
   FIREBASE ADMIN INIT
========================================================= */

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON)),
});

/* =========================================================
   GEMINI INIT
========================================================= */

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

async function requireUser(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";

    if (!token) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid };

    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid/expired token" });
  }
}

/* =========================================================
   SAFE JSON PARSER
========================================================= */

function parseJSON(text) {
  let s = String(text || "").trim();

  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?/i, "").trim();
    s = s.replace(/```$/i, "").trim();
  }

  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(s);
}

/* =========================================================
   PROMPT BUILDERS
========================================================= */

function buildPlanPrompt(input) {
  return `
Return ONLY valid JSON (no markdown).
Schema:
{
 "title":"string",
 "rangeDays":number,
 "dailyPlan":[
   {
     "dateOffset":number,
     "focusBlocks":[
        {"subject":"string","minutes":number,"task":"string"}
     ],
     "breakAdvice":"string"
   }
 ],
 "tasksToCreate":[
   {"title":"string","subject":"string","plannedMinutes":number}
 ]
}
Input:
${JSON.stringify(input)}
`.trim();
}

function buildInsightsPrompt(payload) {
  return `
Return ONLY valid JSON (no markdown).
Schema:
{
 "burnoutRisk":"low|medium|high",
 "summary":"string",
 "insights":["string","string","string"],
 "recommendations":["string","string","string"],
 "studyPlanAdjustments":["string","string"],
 "metrics":{
    "totalMinutes":number,
    "sessionsCompleted":number,
    "avgMinutesPerDay":number,
    "completionRate":number
 }
}
Student Data:
${JSON.stringify(payload)}
`.trim();
}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

/* =========================================================
   OPTIONAL: GET /ai/chat (browser test)
========================================================= */

app.get("/ai/chat", (_, res) => {
  res.json({ ok: true, note: "Use POST /ai/chat with Bearer token" });
});

/* =========================================================
   AI PLAN
========================================================= */

app.post("/ai/plan", requireUser, async (req, res) => {
  try {
    const input = req.body?.input ?? req.body;

    if (!input) return res.status(400).json({ error: "Missing input" });

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const result = await model.generateContent(buildPlanPrompt(input));
    const json = parseJSON(result?.response?.text?.() ?? "");

    res.json(json);
  } catch (e) {
    res.status(500).json({
      error: "Plan failed",
      details: String(e.message || e),
    });
  }
});

/* =========================================================
   AI INSIGHTS
========================================================= */

app.post("/ai/insights", requireUser, async (req, res) => {
  try {
    const payload = req.body?.payload ?? req.body;

    if (!payload)
      return res.status(400).json({ error: "Missing payload body" });

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const result = await model.generateContent(buildInsightsPrompt(payload));
    const json = parseJSON(result?.response?.text?.() ?? "");

    res.json(json);
  } catch (e) {
    res.status(500).json({
      error: "Insights failed",
      details: String(e.message || e),
    });
  }
});

/* =========================================================
   AI TASK OPTIMIZATION
========================================================= */

app.post("/ai/optimize", requireUser, async (req, res) => {
  try {
    const payload = req.body?.payload ?? req.body?.input ?? req.body;
    if (!payload)
      return res.status(400).json({ error: "Missing payload" });

    const {
      subjects,
      energyLevel,
      upcomingDeadlines,
      hardestToday,
      tasks,
    } = payload;

    const prompt = `
Return ONLY valid JSON (no markdown).
You are a study productivity coach. The student wrote their own tasks.
Optimize WITHOUT inventing new tasks.

Context:
- Subjects: ${subjects || "General"}
- Energy level (1-5): ${energyLevel ?? 3}
- Upcoming deadlines: ${upcomingDeadlines || "None"}
- Hardest today: ${hardestToday || "None"}

Tasks:
${(tasks || [])
  .map((t, i) => `${i + 1}. ${t.title}`)
  .join("\n")}

Schema:
{
  "optimized": [
    { "title": "string", "priority": 1, "plannedMinutes": 25, "note": "string" }
  ]
}

Rules:
- Keep same titles (do not rename)
- Reorder by priority and deadlines
- If energy is low (1-2), reduce plannedMinutes and add break advice in note
`.trim();

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const result = await model.generateContent(prompt);
    const json = parseJSON(result?.response?.text?.() ?? "");

    res.json(json);
  } catch (e) {
    res.status(500).json({
      error: "Optimize failed",
      details: String(e.message || e),
    });
  }
});

/* =========================================================
   AI CHAT (REAL GEMINI CHATBOT)
========================================================= */

app.post("/ai/chat", requireUser, async (req, res) => {
  try {
    const messages = req.body?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Missing messages[]" });
    }

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }],
    }));

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction:
        "You are a helpful study assistant. Give short, practical advice. Avoid long essays. If user is stressed, give calm actionable steps.",
    });

    const result = await model.generateContent({ contents });

    const reply =
      result?.response?.text?.()?.trim() ||
      "Sorry, I couldn't generate a response.";

    res.json({ reply });
  } catch (e) {
    res.status(500).json({
      error: "Chat failed",
      details: String(e.message || e),
    });
  }
});

/* =========================================================
   SERVER START (RENDER SAFE)
========================================================= */

const port = process.env.PORT || 5055;

app.listen(port, () => {
  console.log(`AI server running on port ${port}`);
});

console.log("Gemini key length:", (process.env.GEMINI_API_KEY || "").length);