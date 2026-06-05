// ─────────────────────────────────────────────────────────────────────────────
// k6 Load Test — Mochan-D Chatbot
// Endpoint : POST http://localhost:8020/api/chat
// Run      : k6 run mochan_load_test.js
// ─────────────────────────────────────────────────────────────────────────────

import http from "k6/http";
import { sleep, check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// ── Custom metrics ────────────────────────────────────────────────────────────
const chatErrors      = new Counter("chat_errors");          // total error count
const rateLimitHits   = new Counter("chat_rate_limit_hits"); // 429 rate limit hits
const errorRate       = new Rate("chat_error_rate");         // % of failed requests
const responseTrend   = new Trend("chat_response_ms", true); // latency distribution
const llmCallsTrend   = new Trend("llm_calls_per_turn");     // LLM calls per response
const processingTrend = new Trend("server_processing_ms");   // server-side processing time

// ── CONFIG — change these to match your setup ─────────────────────────────────
const API_BASE   = "http://localhost:8022";
const CHATBOT_ID = "24c0e23c-c7c0-4bc9-ba64-9708816d17e0";

// ── Test stages — 3 phases: warm-up → stress → cool-down ─────────────────────
//
//  Phase 1 (Smoke)    : 2 VUs for 1 min  → just check everything works
//  Phase 2 (Ramp-up)  : 2 → 50 VUs       → find comfortable operating range
//  Phase 3 (Load)     : hold 50 VUs       → sustained load
//  Phase 4 (Stress)   : 50 → 100 VUs      → push beyond normal
//  Phase 5 (Peak)     : hold 100 VUs      → find breaking point
//  Phase 6 (Cool-down): ramp back to 0    → watch recovery
//
//  Total duration: ~16 minutes
//
//  TIP: For a quick smoke test only, run:
//       k6 run --vus 2 --duration 30s mochan_load_test.js
// ─────────────────────────────────────────────────────────────────────────────
export const options = {
  stages: [
    { duration: "1m",  target: 2   }, // Phase 1 — smoke
    { duration: "3m",  target: 50  }, // Phase 2 — ramp up
    { duration: "3m",  target: 50  }, // Phase 3 — sustained load
    { duration: "3m",  target: 100 }, // Phase 4 — stress
    { duration: "3m",  target: 100 }, // Phase 5 — peak hold
    { duration: "2m",  target: 0   }, // Phase 6 — cool down
  ],

  // ── Pass/fail thresholds ──────────────────────────────────────────────────
  thresholds: {
    // Normal response: 10–15s. We allow up to 20s at p95 to give headroom
    // under load (server slows down when many users hit it simultaneously).
    // Tweak these once you know your baseline from the smoke test.
    chat_response_ms:   ["p(50)<15000", "p(95)<20000"],

    // Error rate must stay below 5%
    chat_error_rate:    ["rate<0.05"],

    // Standard k6 HTTP checks
    http_req_failed:    ["rate<0.05"],
    http_req_duration:  ["p(50)<15000", "p(95)<20000"],
  },
};

// ── Realistic message pool ────────────────────────────────────────────────────
// Simulates a sales chatbot conversation — mix of greeting, questions, objections
const MESSAGES = [
  // Greetings / openers
  "Hello",
  "Hi there",
  "Namaste",

  // Discovery / interest
  "What products do you offer?",
  "Tell me more about your services",
  "What are your pricing plans?",
  "Do you have any ongoing offers?",

  // Need identification
  "I am looking for something for my small business",
  "I need help with customer support automation",
  "Can you help me set up a chatbot?",

  // Objections
  "That seems expensive",
  "I need to think about it",
  "Can I get a discount?",
  "What if it doesn't work for me?",

  // Closing signals
  "How do I get started?",
  "What are the next steps?",
  "I am interested, what do I do now?",

  // General
  "Can you explain that again?",
  "What are the features?",
  "How does this compare to competitors?",
];

// ── Helper: pick a random message ─────────────────────────────────────────────
function randomMessage() {
  return MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
}

// ── Helper: generate a unique user ID per VU ──────────────────────────────────
// __VU  = virtual user number (k6 built-in)
// __ITER = iteration number (k6 built-in)
function makeUserId() {
  return `k6_vu${__VU}_iter${__ITER}`;
}

// ── Rate-limit constants ──────────────────────────────────────────────────────
const MIN_TURN_GAP_S = 20;   // server enforces ~15s between messages per user
const MAX_RETRIES    = 3;    // how many times to retry a 429 before giving up
const RETRY_WAIT_S   = 16;   // wait this long after a 429 before retrying

// ── Main test function (runs once per VU per iteration) ───────────────────────
export default function () {
  // Stagger VU startup to avoid thundering-herd at t=0.
  // Without this, all VUs fire their first request simultaneously.
  sleep(Math.random() * 10); // 0–10s random startup delay

  const userId      = makeUserId();
  const chatHistory = [];          // each VU maintains its own conversation history

  // Each VU sends between 2–4 messages to simulate a short conversation
  const turnCount = Math.floor(Math.random() * 3) + 2; // 2, 3, or 4 turns

  for (let turn = 0; turn < turnCount; turn++) {
    const message = randomMessage();

    const payload = JSON.stringify({
      user_query:   message,
      userId:       userId,
      chatbotId:    CHATBOT_ID,
      source:       "web",
      chat_history: chatHistory,
    });

    const params = {
      headers: { "Content-Type": "application/json" },
      timeout: "45s", // normal reply is 10–15s; 45s gives headroom under load
      tags:    { turn: String(turn + 1) }, // tag each request with turn number
    };

    // ── POST with 429 retry ─────────────────────────────────────────────────
    let res;
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      res = http.post(`${API_BASE}/api/chat`, payload, params);
      if (res.status !== 429) break;
      attempt++;
      if (attempt <= MAX_RETRIES) {
        rateLimitHits.add(1);
        console.warn(
          `[VU ${__VU} | Turn ${turn + 1}] 429 rate-limited — ` +
          `waiting ${RETRY_WAIT_S}s before retry ${attempt}/${MAX_RETRIES}`
        );
        sleep(RETRY_WAIT_S);
      }
    }

    const ms  = res.timings.duration; // use k6's built-in timing (more accurate)

    // ── Record latency ──────────────────────────────────────────────────────
    responseTrend.add(ms);

    // ── Parse response ──────────────────────────────────────────────────────
    let data = null;
    let parseOk = false;
    try {
      data    = res.json();
      parseOk = true;
    } catch (_) { /* non-JSON response */ }

    // ── Checks ──────────────────────────────────────────────────────────────
    const passed = check(res, {
      "status is 200":          (r) => r.status === 200,
      "response has body":      (r) => r.body && r.body.length > 0,
      "response field present": () => parseOk && data && data.response != null,
    });

    if (!passed) {
      chatErrors.add(1);
      errorRate.add(1);

      // Log failure details (visible with k6 --verbose or in k6 Cloud)
      console.error(
        `[VU ${__VU} | Turn ${turn + 1}] FAILED — ` +
        `status=${res.status} | body=${res.body ? res.body.slice(0, 200) : "empty"}`
      );
    } else {
      errorRate.add(0);

      // ── Record server-side debug metrics if present ───────────────────────
      if (data) {
        // LLM calls per turn (from your debug panel)
        if (data.llm_calls != null) {
          llmCallsTrend.add(data.llm_calls);
        }
        // Server processing time in ms
        if (data.processing_time && data.processing_time.total != null) {
          processingTrend.add(data.processing_time.total * 1000);
        }
      }

      // ── Append to conversation history (mimics your index.html logic) ─────
      chatHistory.push({ role: "user",      content: message });
      chatHistory.push({ role: "assistant", content: data ? data.response : "" });
    }

    // ── Think time between turns ──────────────────────────────────────────────
    // Server requires ~15s between messages per user. We use 13–18s to stay
    // safely above the limit while still feeling like a real user.
    if (turn < turnCount - 1) {
      sleep(Math.random() * 5 + MIN_TURN_GAP_S - 2); // 13–18s pause between messages
    }
  }

  // ── Pause between full conversations (simulates user closing/reopening) ──────
  sleep(Math.random() * 10 + 10); // 10–20s between sessions
}

// ── Summary handler — printed at the end of the test ─────────────────────────
export function handleSummary(data) {
  // Print a clean summary to stdout
  return {
    stdout: buildSummary(data),
  };
}

function buildSummary(data) {
  const m = data.metrics;

  const p50  = val(m, "chat_response_ms", "p(50)");
  const p95  = val(m, "chat_response_ms", "p(95)");
  const p99  = val(m, "chat_response_ms", "p(99)");
  const errR = val(m, "chat_error_rate",  "rate");
  const rlHits = m["chat_rate_limit_hits"] ? m["chat_rate_limit_hits"].values.count : 0;
  const llm  = val(m, "llm_calls_per_turn", "avg");
  const proc = val(m, "server_processing_ms", "p(95)");

  return `
╔══════════════════════════════════════════════════════════╗
║          Mochan-D Chatbot — k6 Load Test Results         ║
╠══════════════════════════════════════════════════════════╣
║  LATENCY (end-to-end, client perspective)                ║
║    p50  : ${pad(p50  != null ? ms(p50)  : "n/a")}                          ║
║    p95  : ${pad(p95  != null ? ms(p95)  : "n/a")}                          ║
║    p99  : ${pad(p99  != null ? ms(p99)  : "n/a")}                          ║
╠══════════════════════════════════════════════════════════╣
║  RELIABILITY                                             ║
║    Error rate     : ${pad(errR != null ? pct(errR) : "n/a")}               ║
║    429 rate-limits: ${pad(String(rlHits))}                                 ║
╠══════════════════════════════════════════════════════════╣
║  SERVER-SIDE (from response debug fields)                ║
║    Avg LLM calls/turn : ${pad(llm  != null ? llm.toFixed(2)  : "n/a")}     ║
║    p95 processing     : ${pad(proc != null ? ms(proc) : "n/a")}            ║
╚══════════════════════════════════════════════════════════╝
`;
}

function val(metrics, name, stat) {
  return metrics[name] && metrics[name].values
    ? metrics[name].values[stat]
    : null;
}
function ms(v)  { return Math.round(v) + " ms"; }
function pct(v) { return (v * 100).toFixed(2) + "%"; }
function pad(s) { return String(s).padEnd(8); }