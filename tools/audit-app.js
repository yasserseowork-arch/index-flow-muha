#!/usr/bin/env node
// IndexFlow — فحص «نداء لدالة غير معرّفة» على كود التطبيق + تغطية مفاتيح الترجمة.
// الاستخدام: node tools/audit-app.js
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "index-flow");
const FILES = ["background.js", "content-script.js", "side-panel.js"];

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "new", "await",
  "delete", "void", "throw", "else", "do", "try", "case", "in", "of", "yield", "instanceof",
  "var", "let", "const", "class", "super", "this", "break", "continue"
]);

const GLOBALS = new Set([
  // JS/Web APIs
  "console", "Math", "JSON", "Number", "String", "Boolean", "Array", "Object", "Promise",
  "Date", "RegExp", "Error", "TypeError", "RangeError", "URL", "URLSearchParams", "TextDecoder",
  "Blob", "Response", "Request", "AbortController", "AbortSignal", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask",
  "crypto", "structuredClone", "decodeURIComponent", "encodeURIComponent", "decodeURI", "encodeURI",
  "isNaN", "isFinite", "parseInt", "parseFloat", "Intl", "fetch", "atob", "btoa", "alert",
  "confirm", "prompt", "MutationObserver", "ResizeObserver", "IntersectionObserver", "InputEvent",
  "KeyboardEvent", "MouseEvent", "Event", "CustomEvent", "HTMLElement", "HTMLInputElement",
  "HTMLButtonElement", "HTMLTextAreaElement", "HTMLSelectElement", "Node", "document", "window",
  "navigator", "location", "getComputedStyle", "matchMedia", "CSS", "DOMParser", "XMLSerializer",
  "FileReader", "DecompressionStream", "CompressionStream", "sessionStorage",
  "localStorage", "chrome", "performance", "process", "require", "module", "exports", "__dirname",
  "Set", "Map", "WeakMap", "WeakSet", "Symbol", "Proxy", "Reflect", "BigInt",
  "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array",
  "Float32Array", "Float64Array", "ArrayBuffer", "SharedArrayBuffer", "DataView",
  // vendor (fast-xml-parser bundle)
  "XMLParser", "XMLValidator"
]);

// كلمات سياقية بتظهر كـ name(...) داخل أكواد/قوالب ولازم تتجاهل
const CONTEXT_WORDS = new Set(["async"]);

// إزالة النصوص والتعليقات والـ regex literals عشان النداءات اللي جوّا Strings ما تتصحّش غلط
function stripStringsAndComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let prev = "";
  let prevWord = "";
  const regexAfter = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "\n", ""]);
  const regexAfterWord = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "else", "do", "yield", "await"]);
  const push = (text) => {
    out += text;
    if (text.length > 0 && !/\s/.test(text[text.length - 1])) prev = text[text.length - 1];
  };
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          out += " ${";
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const c = src[i];
            if (c === "{") depth += 1;
            else if (c === "}") depth -= 1;
            if (depth > 0) out += c;
            if (c === "\n") out += "";
            i += 1;
          }
          out += "} ";
          continue;
        }
        if (src[i] === "\n") out += "\n";
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      prev = " ";
      prevWord = "";
      continue;
    }
    if (ch === "/" && (regexAfter.has(prev) || regexAfterWord.has(prevWord))) {
      i += 1;
      let inClass = false;
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (closed) {
        while (i < n && /[a-z]/.test(src[i])) i += 1;
        out += " /re/ ";
        prev = "/";
        prevWord = "";
        continue;
      }
      push("/");
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      out += word;
      prev = word[word.length - 1];
      prevWord = word;
      i = j;
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) {
      prev = ch;
      if (!/[\w$]/.test(ch)) prevWord = "";
    } else if (ch === "\n") {
      prev = "\n";
    }
    i += 1;
  }
  return out;
}

function extractAppSource(file, source) {
  if (file === "background.js") {
    const start = source.indexOf("// src/utils/url.ts");
    const end = source.indexOf("chrome.runtime.onMessage.addListener");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("تعذر تحديد حدود كود التطبيق في background.js");
    }
    return source.slice(start, end);
  }
  return source;
}

function collectDeclarations(src) {
  const names = new Set();
  let match;
  const patterns = [
    /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g, // function declarations
    /\bclass\s+([A-Za-z_$][\w$]*)/g, // classes
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g, // variable declarations
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g, // catch bindings
    /[{,]\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:=>|\{)/g // object/class method shorthand
  ];
  for (const re of patterns) {
    while ((match = re.exec(src)) !== null) names.add(match[1]);
  }
  // destructuring: const { a, b: c } = … / const [x, y] =
  const destructure = /\b(?:var|let|const)\s*[{[]([^}\]]+)[}\]]/g;
  while ((match = destructure.exec(src)) !== null) {
    for (const part of match[1].split(",")) {
      const name = part.split(":")[0].replace(/\s*=\s*[\s\S]*$/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // parameter lists: (a, b = 1, ...rest) followed by => or {
  const params = /\(([^()]*)\)\s*(?:=>|\{)/g;
  while ((match = params.exec(src)) !== null) {
    for (const part of match[1].split(",")) {
      const name = part.replace(/=\s*[\s\S]*$/, "").replace(/^\s*\.{3}/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function findBareCalls(src) {
  const calls = [];
  const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const line = src.slice(0, match.index).split("\n").length;
    calls.push({ name: match[1], line });
  }
  return calls;
}

function auditCalls() {
  const problems = [];
  for (const file of FILES) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const app = stripStringsAndComments(extractAppSource(file, source));
    const declared = collectDeclarations(app);
    const seen = new Set();
    for (const { name, line } of findBareCalls(app)) {
      if (KEYWORDS.has(name) || GLOBALS.has(name) || CONTEXT_WORDS.has(name) || declared.has(name)) continue;
      const key = `${file}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push(`${file} — نداء لدالة غير معرّفة: ${name}() (سطر ~${line})`);
    }
  }
  return problems;
}

function auditI18n() {
  const problems = [];
  const html = fs.readFileSync(path.join(root, "side-panel.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "side-panel.js"), "utf8");
  const ar = JSON.parse(fs.readFileSync(path.join(root, "i18n", "ar.json"), "utf8"));

  const htmlKeys = new Set();
  for (const match of html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)) htmlKeys.add(match[1]);
  const tKeys = new Set();
  for (const match of js.matchAll(/\bt\(\s*"([^"]+)"/g)) tKeys.add(match[1]);

  const fbStart = js.indexOf("var fallbackDictionary = {");
  if (fbStart === -1) throw new Error("fallbackDictionary غير موجود في side-panel.js");
  const fbEnd = js.indexOf("};", fbStart);
  const fbBlock = js.slice(fbStart, fbEnd);
  const fbKeys = new Set();
  for (const match of fbBlock.matchAll(/^\s*"([^"]+)":/gm)) fbKeys.add(match[1]);

  const arKeys = new Set(Object.keys(ar));
  for (const [label, keys] of [["HTML", htmlKeys], ["t()", tKeys]]) {
    for (const key of keys) {
      if (!arKeys.has(key)) problems.push(`i18n — مفتاح ${label} غير موجود في ar.json: ${key}`);
      if (!fbKeys.has(key)) problems.push(`i18n — مفتاح ${label} غير موجود في fallbackDictionary: ${key}`);
    }
  }
  for (const key of arKeys) {
    if (!fbKeys.has(key)) problems.push(`i18n — مفتاح ar.json مفقود من fallbackDictionary: ${key}`);
  }
  for (const key of fbKeys) {
    if (!arKeys.has(key)) problems.push(`i18n — مفتاح fallbackDictionary مفقود من ar.json: ${key}`);
  }
  return problems;
}

const problems = [...auditCalls(), ...auditI18n()];
if (problems.length > 0) {
  console.error(`فشل الفحص — ${problems.length} مشكلة:`);
  for (const problem of problems) console.error("  ✗ " + problem);
  process.exit(1);
}
console.log("AUDIT CLEAN — مفيش نداءات لمعرّفات غير موجودة، وتغطية مفاتيح الترجمة مكتملة.");
