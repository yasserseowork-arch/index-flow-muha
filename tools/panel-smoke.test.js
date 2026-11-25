#!/usr/bin/env node
// IndexFlow — اختبار تحميل فعلي للوحة في jsdom (وضع المعاينة).
// محتاج مكتبة jsdom: npm install jsdom  (بيتخطى بلطف لو مش مثبتة)
"use strict";

const fs = require("fs");
const path = require("path");

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch {
  console.log("SKIP — jsdom مش مثبتة (npm install jsdom) — الاختبار اتخطى.");
  process.exit(0);
}

const root = path.join(__dirname, "..", "index-flow");
const html = fs.readFileSync(path.join(root, "side-panel.html"), "utf8");
const js = fs.readFileSync(path.join(root, "side-panel.js"), "utf8");

const problems = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => {
  const message = String(error && error.message);
  if (message.includes("Could not parse CSS")) return; // jsdom لا يدعم بعض خصائص CSS الحديثة
  if (message.includes("scrollIntoView") || message.includes("CSS.escape")) return; // محدوديات jsdom — كروم يدعمها
  problems.push("jsdomError: " + message);
});
virtualConsole.on("error", (...args) => problems.push("console.error: " + args.join(" ")));

const dom = new JSDOM(html, {
  url: "chrome-extension://test/side-panel.html",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole
});
const { window } = dom;

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  ✓ " + name);
  } else {
    failed += 1;
    console.error("  ✗ " + name + (detail ? " → " + detail : ""));
  }
}

(async () => {
  // محدوديات jsdom — كلها موجودة في كروم الحقيقي:
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (value) => String(value).replace(/[^\w-]/g, "\\$&");
  if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = function () {};
  if (typeof window.fetch !== "function") {
    const arJson = fs.readFileSync(path.join(root, "i18n", "ar.json"), "utf8");
    window.fetch = async () => ({ ok: true, json: async () => JSON.parse(arJson) });
  }

  try {
    window.eval(js);
  } catch (error) {
    problems.push("eval threw: " + error.message);
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  const doc = window.document;

  console.log("\nتحميل اللوحة:");
  check("السكربت اتنفذ من غير استثناء", problems.length === 0, problems.join(" | "));
  check("مفيش عنصر UI ناقص (Missing UI element)", !problems.some((p) => p.includes("Missing UI element")), problems.join(" | "));
  check("مفيش ReferenceError", !problems.some((p) => p.includes("ReferenceError")), problems.join(" | "));

  console.log("\nالعنوان يتبع حالة التشغيل:");
  const runTitle = doc.getElementById("runTitle");
  check("runTitle = «قيد التشغيل» في وضع المعاينة", runTitle && runTitle.textContent === "قيد التشغيل", runTitle && runTitle.textContent);
  check("شارة الحالة المكررة اتشالت من كارت التشغيل", !doc.getElementById("runPill"));
  check("شارة الحالة في الهيدر موجودة", Boolean(doc.getElementById("headerPill")));

  console.log("\nالمعاينة اترسمت:");
  const rows = doc.querySelectorAll(".queue-item");
  check("صفوف الطابور = 6", rows.length === 6, "الفعلي: " + rows.length);
  const pending = doc.getElementById("pendingCount");
  const processing = doc.getElementById("processingCount");
  const requested = doc.getElementById("requestedCount");
  const skipped = doc.getElementById("skippedCount");
  const errors = doc.getElementById("errorCount");
  check("عداد قيد الانتظار = 2", pending && pending.textContent === "2", pending && pending.textContent);
  check("عداد قيد المعالجة = 1", processing && processing.textContent === "1", processing && processing.textContent);
  check("عداد تم الإرسال = 1", requested && requested.textContent === "1", requested && requested.textContent);
  check("عداد تم التخطي = 1", skipped && skipped.textContent === "1", skipped && skipped.textContent);
  check("عداد الأخطاء = 1", errors && errors.textContent === "1", errors && errors.textContent);
  const percent = doc.getElementById("progressPercent");
  check("نسبة التقدم = 50%", percent && percent.textContent.includes("50"), percent && percent.textContent);

  console.log("\nخطوة المعالج الرابعة ظاهرة:");
  const step4 = doc.querySelector('.wizard-step[data-step="4"]');
  check("الخطوة 4 active", step4 && step4.classList.contains("active"));
  const controlCard = doc.querySelector('.control-card[data-wizard-step="4"]');
  check("كارت التشغيل ظاهر", controlCard && !controlCard.hidden);
  const dashboard = doc.querySelector('.dashboard[data-wizard-step="4"]');
  check("لوحة المتابعة ظاهرة", dashboard && !dashboard.hidden);

  console.log("\nأكورديون سجل النشاط:");
  const logBody = doc.getElementById("logBody");
  const toggleLog = doc.getElementById("toggleLogButton");
  check("السجل مقفول افتراضيًا", logBody && logBody.hidden);
  check("زر التبديل موجود ومعايره صح", toggleLog && toggleLog.getAttribute("aria-expanded") === "false");
  if (toggleLog && logBody) {
    toggleLog.click();
    check("الدوسة بتفتح السجل", !logBody.hidden && toggleLog.getAttribute("aria-expanded") === "true");
    toggleLog.click();
    check("الدوسة التانية بتسكره", logBody.hidden && toggleLog.getAttribute("aria-expanded") === "false");
  } else {
    check("الدوسة بتفتح السجل", false, "العناصر ناقصة");
    check("الدوسة التانية بتسكره", false, "العناصر ناقصة");
  }

  console.log("\nالترجمة اتطبقت:");
  const heading = doc.querySelector(".brand h1");
  check("العنوان الرئيسي عربي", heading && heading.textContent.includes("الفهرسة"), heading && heading.textContent);
  const startBtn = doc.querySelector("#startButton span");
  check("زر البدء يقول «بدء الطابور»", startBtn && startBtn.textContent === "بدء الطابور", startBtn && startBtn.textContent);
  check("زر السجل يقول «إظهار سجل النشاط»", toggleLog && toggleLog.getAttribute("aria-label") === "إظهار سجل النشاط", toggleLog && toggleLog.getAttribute("aria-label"));

  console.log("\nالأزرار في حالة صحيحة أثناء التشغيل:");
  const start = doc.getElementById("startButton");
  const stop = doc.getElementById("stopButton");
  check("بدء معطّل أثناء التشغيل", start && start.disabled);
  check("إيقاف مفعّل أثناء التشغيل", stop && !stop.disabled);

  await new Promise((resolve) => setTimeout(resolve, 200));
  check("مفيش أخطاء إضافية بعد الاستقرار", problems.length === 0, problems.join(" | "));

  console.log(`\nالنتيجة: ${passed} نجح / ${failed} فشل`);
  window.close();
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
