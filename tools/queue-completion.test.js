#!/usr/bin/env node
// IndexFlow — اختبارات منطق الطابور: الإكمال الصادق، رابط النتيجة المفقودة، الإيقاف الآمن.
// الاستخدام: node tools/queue-completion.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { webcrypto } = require("crypto");

const src = fs.readFileSync(path.join(__dirname, "..", "index-flow", "background.js"), "utf8");
const start = src.indexOf("// src/utils/url.ts");
const end = src.indexOf("chrome.runtime.onMessage.addListener");
if (start === -1 || end === -1 || end <= start) {
  console.error("تعذر تحديد حدود كود التطبيق في background.js");
  process.exit(1);
}
const app = src.slice(start, end);

const storageData = {};
const alarmsCreated = [];
const tabMessages = [];
let tabResponse = null;

const chromeStub = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storageData[key] };
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) out[k] = storageData[k];
          return out;
        }
        return { ...storageData };
      },
      async set(obj) {
        Object.assign(storageData, obj);
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete storageData[k];
      },
      async setAccessLevel() {}
    },
    session: {
      async get() {
        return {};
      },
      async set() {},
      async remove() {}
    }
  },
  alarms: {
    create(name, info) {
      alarmsCreated.push({ name, info });
    },
    async clear() {
      return true;
    },
    onAlarm: { addListener() {} }
  },
  tabs: {
    async sendMessage(tabId, message) {
      tabMessages.push({ tabId, message });
      return typeof tabResponse === "function" ? tabResponse(tabId, message) : tabResponse;
    },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} }
  },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} }
  },
  notifications: { async create() {} },
  sidePanel: { async setPanelBehavior() {} },
  scripting: { async executeScript() {} },
  windows: { async update() {} }
};

class XMLParser {
  parse() {
    return {};
  }
}
class XMLValidator {
  static validate() {
    return true;
  }
}

const sandbox = {
  console,
  Date,
  Math,
  JSON,
  Promise,
  URL,
  URLSearchParams,
  TextDecoder,
  AbortController,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  crypto: webcrypto,
  chrome: chromeStub,
  XMLParser,
  XMLValidator,
  fetch: async () => {
    throw new Error("لا يوجد شبكة في الاختبارات");
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(app, sandbox, { filename: "background-app.js" });

const api = vm.runInContext(
  `({
    createDefaultState, computeStats, claimNextItem, applyWorkResult, requeueProcessingItems,
    getOperationDelaySeconds, nextItem, stopQueue, setState, getState, pushLog,
    quotaBlockResetAt, isQuotaBlockActive, createQueue
  })`,
  sandbox
);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ✓ " + name);
  } catch (error) {
    failed += 1;
    console.error("  ✗ " + name + " → " + error.message);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ✓ " + name);
  } catch (error) {
    failed += 1;
    console.error("  ✗ " + name + " → " + error.message);
  }
}

function makeItem(id, status = "pending") {
  return {
    id,
    url: `https://example.com/${id}`,
    normalizedUrl: `https://example.com/${id}`,
    status,
    gscPageStatus: "unknown",
    attemptCount: 0,
    createdAt: Date.now()
  };
}

function baseState(items) {
  const state = api.createDefaultState();
  state.queue = items;
  state.stats = api.computeStats(items);
  state.runState = {
    status: "running",
    runId: "run-test",
    gscTabId: 7,
    stopRequested: false,
    finalRetryDone: false,
    startedAt: Date.now()
  };
  return state;
}

(async () => {
  console.log("\n1) الإكمال الصادق — مفيش إكمال وفي رابط لسه pending/processing");
  await checkAsync("النتيجة الأولى تسيب التشغيل شغال، والتانية تكمله", async () => {
    const state = baseState([makeItem("a"), makeItem("b")]);
    const first = api.claimNextItem(state, "run-test");
    assert.ok(first && first.item.id === "a", "يجب مطالبة الرابط الأول");
    let applied = api.applyWorkResult(state, "run-test", first.operationId, "a", {
      outcome: "accepted",
      gscPageStatus: "new_page",
      reason: "ok"
    });
    assert.strictEqual(applied.accepted, true);
    assert.strictEqual(applied.continueRunning, true, "لابد يستمر بعد الرابط الأول");
    assert.notStrictEqual(state.runState.status, "completed", "ممنوع إكمال قبل الأخير");
    assert.ok(!state.completionNotice, "مفيش إشعار إكمال قبل الآخر");
    const second = api.claimNextItem(state, "run-test");
    assert.ok(second && second.item.id === "b", "يجب مطالبة الرابط الثاني");
    applied = api.applyWorkResult(state, "run-test", second.operationId, "b", {
      outcome: "accepted",
      gscPageStatus: "indexed_page",
      reason: "ok"
    });
    assert.strictEqual(applied.continueRunning, false, "بعد الأخير: لا استمرار");
    assert.strictEqual(state.runState.status, "completed", "الحالة تكتمل بعد الأخير");
    assert.ok(state.completionNotice, "إشعار الإكمال يتولد مع الرابط الأخير");
    assert.strictEqual(state.completionNotice.requested, 2);
    const stats = api.computeStats(state.queue);
    assert.strictEqual(stats.requested, 2);
    assert.strictEqual(stats.pending, 0);
    assert.strictEqual(stats.processing, 0);
  });

  console.log("\n2) رابط النتيجة المفقودة — NEXT_ITEM بآخر تقرير = إعادة مطالبة فورية");
  await checkAsync("الإعادة تتم على طول بدون إيقاف يدوي", async () => {
    const state = baseState([makeItem("x")]);
    const claimed = api.claimNextItem(state, "run-test");
    assert.ok(claimed && state.queue[0].status === "processing");
    await api.setState(state);
    const sender = { tab: { id: 7 } };
    const out = await api.nextItem({ runId: "run-test", lastReportedItemId: "x" }, sender);
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.done, false, "التشغيل مستمر");
    assert.ok(out.item, "الرابط تُطالب من جديد");
    assert.strictEqual(out.item.id, "x");
    const after = await api.getState();
    assert.strictEqual(after.queue[0].status, "processing", "عاد للمعالجة");
    assert.strictEqual(after.queue[0].attemptCount, 2, "محاولة ثانية بعد الفقد");
    const hasWarning = after.logs.some((entry) => entry.level === "warning" && entry.message.includes("لم تُسجّل"));
    assert.ok(hasWarning, "سجل تحذيري واضح للفقد");
  });

  console.log("\n3) مطالبة أثناء معالجة أخرى = busy مش انقطاع");
  await checkAsync("بدون آخر تقرير: busy=true وعدم قتل الحلقة", async () => {
    const state = baseState([makeItem("y"), makeItem("z")]);
    api.claimNextItem(state, "run-test"); // y processing
    await api.setState(state);
    const out = await api.nextItem({ runId: "run-test", lastReportedItemId: "" }, { tab: { id: 7 } });
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.done, false, "مش مكتمل");
    assert.strictEqual(out.busy, true, "يجب busy=true");
    assert.ok(!out.item, "ممنوع إرجاع رابط أثناء معالجة أخرى");
    assert.strictEqual(state.queue[0].status, "processing", "المعالجة الحالية لم تتأثر");
  });

  console.log("\n4) مطالبة بتشغيل قديم = خروج نظيف (done)");
  await checkAsync("تشغيل منتهي لا يستمر في الانتظار", async () => {
    const state = baseState([makeItem("w")]);
    state.runState.runId = "run-new";
    await api.setState(state);
    const out = await api.nextItem({ runId: "run-old", lastReportedItemId: "" }, { tab: { id: 7 } });
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.done, true, "التشغيل القديم يخرج بـ done");
    assert.strictEqual(out.busy, false);
  });

  console.log("\n5) الإيقاف الآمن — زر الإيقاف يثبت الحالة فورًا");
  await checkAsync("لو مفيش مشغّل نشط: إيقاف فوري + إعادة الرابط", async () => {
    const state = baseState([makeItem("s")]);
    api.claimNextItem(state, "run-test");
    await api.setState(state);
    tabResponse = { success: true, hadActiveRun: false };
    const stopped = await api.stopQueue();
    assert.strictEqual(stopped.runState.status, "stopped", "الحالة تتثبت على متوقف");
    assert.strictEqual(stopped.runState.stopRequested, false);
    assert.strictEqual(stopped.queue[0].status, "pending", "الرابط النشط يرجع للانتظار");
    assert.ok(
      alarmsCreated.some((alarm) => alarm.name === "stop-run-test"),
      "منبّه أمان للإيقاف المسجّل"
    );
    tabResponse = null;
  });
  await checkAsync("لو في مشغّل نشط: stopping مؤقت + منبّه أمان", async () => {
    const state = baseState([makeItem("t")]);
    api.claimNextItem(state, "run-test");
    await api.setState(state);
    tabResponse = { success: true, hadActiveRun: true };
    const stopped = await api.stopQueue();
    assert.strictEqual(stopped.runState.status, "stopping", "ينتظر نقطة الأمان");
    assert.ok(
      alarmsCreated.some((alarm) => alarm.name === "stop-run-test" || alarm.name === "stop-run-test"),
      "منبّه أمان مسجل"
    );
    tabResponse = null;
  });

  console.log("\n6) اليتيم في ذيل التقرير — أي processing بلا مشغّل يرجع قبل الإكمال");
  await checkAsync("إعادة تقرير لرابط ثاني تعيد اليتيم وتمنع الإكمال الكاذب", async () => {
    const state = baseState([makeItem("p1"), makeItem("p2")]);
    const op1 = api.claimNextItem(state, "run-test");
    state.queue[1].status = "processing";
    state.queue[1].startedAt = Date.now();
    state.queue[1].runId = "run-test";
    state.queue[1].operationId = "op-orphan";
    state.runState.currentItemId = "p2";
    const applied = api.applyWorkResult(state, "run-test", op1.operationId, "p1", {
      outcome: "accepted",
      gscPageStatus: "new_page",
      reason: "ok"
    });
    assert.strictEqual(applied.accepted, true);
    assert.strictEqual(state.queue[1].status, "pending", "اليتيم يرجع للانتظار");
    assert.notStrictEqual(state.runState.status, "completed", "ممنوع إكمال ورابط يتيم");
    assert.strictEqual(applied.continueRunning, true, "يستمر ليعالج اليتيم");
  });

  console.log("\n7) أدوات مساعدة");
  check("تأخير التخطي 10 ثوانٍ كحد أدنى", () => {
    assert.strictEqual(api.getOperationDelaySeconds("skipped_mode", 120), 10);
  });
  check("تأخير عادي = الإعداد لا يقل عن 10", () => {
    assert.strictEqual(api.getOperationDelaySeconds("accepted", 45), 45);
    assert.strictEqual(api.getOperationDelaySeconds("accepted", 3), 10);
  });
  check("تأخير الحصة = الإعداد المخصص لا يقل عن 10", () => {
    assert.strictEqual(api.getOperationDelaySeconds("quota", 45, 1800), 1800);
    assert.strictEqual(api.getOperationDelaySeconds("quota", 45, 2), 10);
  });
  check("حجز الحصة ينتهي عند منتصف الليل المحلي", () => {
    const now = Date.now();
    const reset = api.quotaBlockResetAt(now);
    assert.ok(reset > now, "التجديد في المستقبل");
    const d = new Date(reset);
    assert.strictEqual(d.getHours(), 0);
    assert.strictEqual(d.getMinutes(), 0);
    assert.strictEqual(d.getSeconds(), 0);
    assert.strictEqual(api.isQuotaBlockActive(now - 3 * 864e5), false, "حجز قديم منتهٍ");
    assert.strictEqual(api.isQuotaBlockActive(now), true, "حجز نهاردة فعّال");
  });
  check("computeStats بتعدّ كل الحالات", () => {
    const stats = api.computeStats([
      makeItem("1", "pending"),
      makeItem("2", "processing"),
      makeItem("3", "request_sent"),
      makeItem("4", "skipped_mode"),
      makeItem("5", "quota_blocked"),
      makeItem("6", "error")
    ]);
    assert.deepStrictEqual(
      [stats.pending, stats.processing, stats.requested, stats.skipped, stats.quotaBlocked, stats.errors],
      [1, 1, 1, 1, 1, 1]
    );
    assert.strictEqual(stats.total, 6);
  });

  console.log(`\nالنتيجة: ${passed} نجح / ${failed} فشل`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
