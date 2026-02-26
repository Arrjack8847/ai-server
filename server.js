import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: true, // later you can lock to your Firebase Hosting domain
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
if (!FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON)),
});

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

async function requireUser(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid };
    next();
  } catch {
    res.status(401).json({ error: "Invalid/expired token" });
  }
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
 "metrics":{"totalMinutes":number,"sessionsCompleted":number,"avgMinutesPerDay":number,"completionRate":number}
}
Data:
${JSON.stringify(payload)}
`.trim();
}

function buildPlanPrompt(input) {
  return `
Return ONLY valid JSON (no markdown).
Schema:
{
 "title":"string",
 "rangeDays":number,
 "dailyPlan":[{"dateOffset":number,"focusBlocks":[{"subject":"string","minutes":number,"task":"string"}],"breakAdvice":"string"}],
 "tasksToCreate":[{"title":"string","subject":"string","plannedMinutes":number}]
}
Input:
${JSON.stringify(input)}
`.trim();
}

function parseJSON(text) {
  return JSON.parse(String(text || "").trim());
}

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/ai/insights", requireUser, async (req, res) => {
  try {
    const payload = req.body?.payload;
    if (!payload) return res.status(400).json({ error: "Missing payload" });

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(buildInsightsPrompt(payload));
    const json = parseJSON(result?.response?.text?.() ?? "");
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: "Insights failed", details: String(e.message || e) });
  }
});

app.post("/ai/plan", requireUser, async (req, res) => {
  try {
    const input = req.body?.input;
    if (!input) return res.status(400).json({ error: "Missing input" });

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(buildPlanPrompt(input));
    const json = parseJSON(result?.response?.text?.() ?? "");
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: "Plan failed", details: String(e.message || e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("AI server on", port));