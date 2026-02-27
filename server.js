import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import https from "https";
import http from "http";

// Playwright is optional (used to bypass NitroEye blocks when curl/axios gets 302 to nitroeye)
let chromium = null;
async function getChromium() {
  if (chromium) return chromium;
  try {
    const mod = await import("playwright");
    chromium = mod.chromium;
    return chromium;
  } catch {
    return null;
  }
}

// =========================================================
// HAFS Cafeteria Bot (rebuild)
// - Buttons: 아침/점심/저녁/오늘/내일/이번주
// - All menus scraped from HAFS site (NO NEIS)
// - Primary strategy: fetch HTML via HTTP (NitroEye often blocks HTTPS with 302)
// - Image proxy kept (optional, used by photo features if you add later)
// =========================================================

const app = express();
app.use(express.json());

// Agents (IPv4 first helps some networks)
const httpsAgent = new https.Agent({ family: 4 });
const httpAgent = new http.Agent({ family: 4 });

// IMPORTANT: do NOT use www.hafs.hs.kr (TLS SAN mismatch)
const HAFS_HOST = "hafs.hs.kr";
const CAFETERIA_CODE = "171113";

// In some environments DNS fails; allow IP fallback.
// If you ever need it, set: HAFS_IP_FALLBACK=114.31.59.153
const HAFS_IP_FALLBACK = process.env.HAFS_IP_FALLBACK || "";
const httpsAgentHafsIp = new https.Agent({
  family: 4,
  servername: "hafs.hs.kr", // keep SNI for cert
});

const BASE_URL = process.env.BASE_URL || "https://hafs-cafeteria.onrender.com";

// ----------------- Kakao UI helpers -----------------
function menuQuickReplies() {
  // Only keep meal buttons. (오늘/내일/이번주 buttons removed)
  return [
    { label: "아침", action: "message", messageText: "아침" },
    { label: "점심", action: "message", messageText: "점심" },
    { label: "저녁", action: "message", messageText: "저녁" },
  ];
}

function kakaoText(text, quickReplies = menuQuickReplies()) {
  const tpl = {
    outputs: [{ simpleText: { text } }],
  };
  if (Array.isArray(quickReplies) && quickReplies.length > 0) {
    tpl.quickReplies = quickReplies;
  }
  return { version: "2.0", template: tpl };
}

function kakaoImageCard(titleText, imageUrl, altText, quickReplies = null) {
  const outputs = [
    { simpleText: { text: titleText } },
    { simpleImage: { imageUrl, altText: altText || titleText } },
  ];
  const tpl = { outputs };
  if (Array.isArray(quickReplies) && quickReplies.length > 0) {
    tpl.quickReplies = quickReplies;
  }
  return { version: "2.0", template: tpl };
}

function photoQuickReplies(ymd, mealKey) {
  return [
    // 카톡에서 label 텍스트가 그대로 발화로 들어오는 경우가 있어서 이 텍스트를 지원할 거야
    { label: "식단 사진 보기", action: "message", messageText: "식단 사진 보기" },
    { label: "아침", action: "message", messageText: "아침" },
    { label: "점심", action: "message", messageText: "점심" },
    { label: "저녁", action: "message", messageText: "저녁" },
  ];
}

// ----------------- Date utils -----------------
function pad2(n) {
  return String(n).padStart(2, "0");
}

function yyyymmdd(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function prettyYmd(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfWeekMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function ymdToDot(ymd) {
  // YYYYMMDD -> YYYY.MM.DD
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

// ----------------- Network / NitroEye handling -----------------
let HAFS_COOKIE = "";

// -------- Playwright fallback (real browser fetch) --------
let pwBrowserPromise = null;

async function getPwBrowser() {
  const chr = await getChromium();
  if (!chr) return null;

  if (!pwBrowserPromise) {
    pwBrowserPromise = chr.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return pwBrowserPromise;
}

async function fetchHtmlWithPlaywright(targetUrl, timeoutMs = 15000) {
  const browser = await getPwBrowser();
  if (!browser) {
    const err = new Error("PLAYWRIGHT_NOT_INSTALLED");
    err.code = "PLAYWRIGHT_NOT_INSTALLED";
    throw err;
  }

  const headers = buildBrowserHeaders();

  const context = await browser.newContext({
    userAgent: headers["User-Agent"],
    locale: "ko-KR",
    extraHTTPHeaders: {
      Accept: headers.Accept,
      "Accept-Language": headers["Accept-Language"],
      "Accept-Encoding": headers["Accept-Encoding"],
      Connection: headers.Connection,
      "Upgrade-Insecure-Requests": headers["Upgrade-Insecure-Requests"],
      Referer: headers.Referer,
      ...(HAFS_COOKIE ? { Cookie: HAFS_COOKIE } : {}),
    },
    ignoreHTTPSErrors: false,
  });

  const page = await context.newPage();

  // Helper: detect firewall by URL or body
  const isFirewallPage = async () => {
    const u = page.url();
    if (u.includes("nitroeye.co.kr/404_firewall")) return true;
    try {
      const body = await page.content();
      return String(body).includes("nitroeye.co.kr/404_firewall") || String(body).includes("404_firewall");
    } catch {
      return false;
    }
  };

  // Helper: wait until meal keywords appear (site sometimes renders after load)
  const waitForMeals = async () => {
    try {
      await page.waitForFunction(
        () => {
          const t = (document.body && document.body.innerText) ? document.body.innerText : "";
          return t.includes("조식") || t.includes("중식") || t.includes("석식") || t.includes("야식");
        },
        { timeout: Math.min(6000, Math.max(2000, Math.floor(timeoutMs / 2))) }
      );
    } catch {
      // ignore: some days might have no meals rendered; parsing will handle empty
    }
  };

  // Try https first (browser often succeeds where axios/curl is blocked), then http.
  const httpsUrl = String(targetUrl).replace(/^http:\/\//i, "https://");
  const httpUrl = String(targetUrl).replace(/^https:\/\//i, "http://");
  const candidates = [httpsUrl, httpUrl];

  try {
    let lastFirewall = false;

    for (const u of candidates) {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: timeoutMs });

      // If blocked, try the next scheme
      lastFirewall = await isFirewallPage();
      if (lastFirewall) continue;

      // Give time for dynamic content, then wait for meal text if present
      await page.waitForTimeout(250);
      await waitForMeals();

      // If after waiting we suddenly got the firewall page, treat as blocked
      lastFirewall = await isFirewallPage();
      if (lastFirewall) continue;

      const content = await page.content();

      // Update cookie jar from browser context
      try {
        const cookies = await context.cookies();
        const cookieStr = cookies
          .map((c) => `${c.name}=${c.value}`)
          .filter(Boolean)
          .join("; ");
        if (cookieStr) HAFS_COOKIE = cookieStr;
      } catch {}

      return content;
    }

    if (lastFirewall) {
      const err = new Error("HAFS_FIREWALL_BLOCK");
      err.code = "HAFS_FIREWALL";
      throw err;
    }

    // If neither worked, surface a generic error
    throw new Error("HAFS_FETCH_FAILED");
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

function buildBrowserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    Referer: `http://${HAFS_HOST}/`,
    ...(HAFS_COOKIE ? { Cookie: HAFS_COOKIE } : {}),
  };
}

function updateCookieFromResponse(resp) {
  const setCookie = resp?.headers?.["set-cookie"];
  if (!setCookie) return;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookie = arr
    .map((c) => String(c).split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (cookie) HAFS_COOKIE = cookie;
}

function isFirewall(resp) {
  const loc = String(resp?.headers?.location || "");
  if (loc.includes("nitroeye.co.kr/404_firewall")) return true;
  try {
    const body = resp?.data ? Buffer.from(resp.data).toString("utf-8") : "";
    return body.includes("nitroeye.co.kr") || body.includes("404_firewall");
  } catch {
    return false;
  }
}

function isRedirect(resp) {
  const s = Number(resp?.status || 0);
  return s >= 300 && s < 400;
}

function resolveRedirectUrl(currentUrl, location) {
  try {
    // Handles relative redirects
    return new URL(location, currentUrl).toString();
  } catch {
    return location;
  }
}

function toIpUrl(originalUrl) {
  if (!HAFS_IP_FALLBACK) return originalUrl;
  try {
    const u = new URL(originalUrl);
    u.hostname = HAFS_IP_FALLBACK;
    return u.toString();
  } catch {
    return originalUrl;
  }
}

async function getHtmlArrayBuffer(url, timeoutMs = 7000) {
  // Fast path: try plain HTTP/HTTPS with axios first (much faster than Playwright).
  // Fallback to Playwright ONLY when NitroEye blocks (302 to nitroeye / firewall body).

  const headers = buildBrowserHeaders();

  // Try both schemes (many environments: HTTPS -> NitroEye 302, HTTP often works)
  const httpsUrl = String(url).replace(/^http:\/\//i, "https://");
  const httpUrl = String(url).replace(/^https:\/\//i, "http://");
  const candidates = [httpUrl, httpsUrl];

  const tryAxios = async (u) => {
    // Some environments have DNS issues; allow IP fallback.
    const ipUrl = toIpUrl(u);
    const useIp = HAFS_IP_FALLBACK && ipUrl !== u;

    const resp = await axios.get(ipUrl, {
      responseType: "arraybuffer",
      timeout: Math.min(Math.max(timeoutMs, 2500), 6000),
      // Important: do NOT auto-follow redirects; we want to detect NitroEye quickly.
      maxRedirects: 0,
      validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
      headers: {
        ...headers,
        // When using IP, preserve SNI+Host for TLS cert / virtual host routing.
        ...(useIp ? { Host: HAFS_HOST } : {}),
      },
      // Use agents (IPv4 first)
      httpAgent,
      httpsAgent: useIp ? httpsAgentHafsIp : httpsAgent,
    });

    updateCookieFromResponse(resp);

    // If redirecting to NitroEye, treat as firewall.
    if (isRedirect(resp) && isFirewall(resp)) {
      const err = new Error("HAFS_FIREWALL_BLOCK");
      err.code = "HAFS_FIREWALL";
      throw err;
    }

    // If a redirect happens, follow it once manually (still faster than Playwright).
    if (isRedirect(resp)) {
      const loc = String(resp.headers?.location || "");
      const nextUrl = resolveRedirectUrl(u, loc);
      if (loc.includes("nitroeye.co.kr/404_firewall")) {
        const err = new Error("HAFS_FIREWALL_BLOCK");
        err.code = "HAFS_FIREWALL";
        throw err;
      }
      const resp2 = await axios.get(toIpUrl(nextUrl), {
        responseType: "arraybuffer",
        timeout: Math.min(Math.max(timeoutMs, 2500), 6000),
        maxRedirects: 0,
        validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
        headers: {
          ...headers,
          ...(HAFS_IP_FALLBACK && toIpUrl(nextUrl) !== nextUrl ? { Host: HAFS_HOST } : {}),
        },
        httpAgent,
        httpsAgent: (HAFS_IP_FALLBACK && toIpUrl(nextUrl) !== nextUrl) ? httpsAgentHafsIp : httpsAgent,
      });
      updateCookieFromResponse(resp2);
      if (isRedirect(resp2) && isFirewall(resp2)) {
        const err = new Error("HAFS_FIREWALL_BLOCK");
        err.code = "HAFS_FIREWALL";
        throw err;
      }
      return resp2;
    }

    // Some blocks return 200 with firewall HTML.
    if (isFirewall(resp)) {
      const err = new Error("HAFS_FIREWALL_BLOCK");
      err.code = "HAFS_FIREWALL";
      throw err;
    }

    return resp;
  };

  let lastErr = null;
  for (const u of candidates) {
    try {
      return await tryAxios(u);
    } catch (e) {
      lastErr = e;
      // If it wasn't a firewall error, continue to next scheme.
      continue;
    }
  }

  // Slow fallback: real browser fetch.
  // Keep this timeout tight so Kakao doesn't hang too long.
  try {
    const html = await fetchHtmlWithPlaywright(url, 9000);
    return {
      status: 200,
      headers: { "content-type": "text/html" },
      data: iconv.encode(html, "euc-kr"),
    };
  } catch (e) {
    // Prefer original firewall code if present
    throw lastErr || e;
  }
}

function decodeHafsHtml(arrayBuffer) {
  const buf = Buffer.from(arrayBuffer);
  try {
    return iconv.decode(buf, "euc-kr");
  } catch {
    return buf.toString("utf-8");
  }
}

function hafsMonthUrl(ymd) {
  // HAFS uses month param as YYYY.MM.DD
  return `http://${HAFS_HOST}/?act=lunch.main2&code=${CAFETERIA_CODE}&month=${ymdToDot(ymd)}`;
}

function hafsDayUrl(ymd) {
  // Same endpoint; day view works by passing the specific date
  return `http://${HAFS_HOST}/?act=lunch.main2&code=${CAFETERIA_CODE}&month=${ymdToDot(ymd)}`;
}

// ----------------- Parsing -----------------
function normalizeHtmlToTextKeepingYa(html) {
  const noScript = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const YA_PLACEHOLDER = "__YA_SNACK__";

  let text = noScript
    // Preserve meal labels that appear as images (e.g., <img alt="조식">)
    .replace(/<img[^>]*(?:alt|title)\s*=\s*"([^"]+)"[^>]*>/gi, (m, a1) => {
      const t = String(a1 || "").replace(/\s+/g, " ").trim();
      if (t.includes("조식") || t.includes("중식") || t.includes("석식") || t.includes("야식")) {
        return "\n" + t + "\n";
      }
      return "\n";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;\s*야식\s*&gt;/gi, `\n${YA_PLACEHOLDER}\n`)
    .replace(/<\s*야식\s*>/gi, `\n${YA_PLACEHOLDER}\n`)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|td|th|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(new RegExp(YA_PLACEHOLDER, "g"), "<야식>");

  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);

  return lines.join("\n");
}

function cleanHafsText(text) {
  if (!text) return "";

  // Lines that are not actual menu items and often appear in HAFS markup
  const dropPhrases = [
    "사진",
    "식단사진",
    "에너지",
    "탄수화물",
    "단백질",
    "지방",
    "칼슘",
    "kcal",
  ];

  const lines = String(text)
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    // remove nutrition labels / non-menu labels
    .filter((l) => !dropPhrases.some((p) => l === p || l.includes(p)))
    // remove very short badges
    .filter((l) => l.length >= 2);

  const uniq = [];
  const seen = new Set();
  for (const l of lines) {
    if (!seen.has(l)) {
      seen.add(l);
      uniq.push(l);
    }
  }
  return uniq.join("\n").trim();
}

function extractMealFromText(joinedText, label) {
  // label: 조식/중식/석식
  const idx = joinedText.lastIndexOf(label);
  if (idx < 0) return null;

  const after = joinedText.slice(idx + label.length);
  const stopKeys = [
    "조식",
    "중식",
    "석식",
    "에너지",
    "탄수화물",
    "단백질",
    "지방",
    "칼슘",
    "kcal",
  ].filter((k) => k !== label);

  let end = after.length;
  for (const k of stopKeys) {
    const j = after.indexOf(k);
    if (j >= 0 && j < end) end = j;
  }

  const block = after.slice(0, end);
  const cleaned = cleanHafsText(block);
  return cleaned || null;
}

function splitDinnerAndLate(dinnerAll) {
  if (!dinnerAll) return { dinner: null, late: null };
  if (!dinnerAll.includes("<야식>")) return { dinner: dinnerAll, late: null };
  const parts = dinnerAll.split("<야식>");
  const dinnerPart = (parts[0] || "").trim();
  const latePart = (parts.slice(1).join("\n") || "").trim();
  return {
    dinner: dinnerPart ? cleanHafsText(dinnerPart) : null,
    late: latePart ? cleanHafsText(latePart) : null,
  };
}

function dayFromCell($, cell) {
  const $cell = $(cell);
  const cls = $cell.find(".day, .date, .cal_day, .num, .dayNum").first().text();
  const tryTexts = [cls, $cell.clone().children().first().text(), $cell.text()];

  for (const t0 of tryTexts) {
    const t = String(t0 || "").replace(/\s+/g, " ").trim();
    const m = t.match(/\b([1-9]|[12]\d|3[01])\b/);
    if (m) return Number(m[1]);
  }
  return null;
}

function parseMonthMeals(html, year, month) {
  const $ = cheerio.load(html);
  const map = new Map();

  const cells = $("td, th").toArray();
  for (const cell of cells) {
    const dayNum = dayFromCell($, cell);
    if (!dayNum) continue;

    const ymd = `${String(year)}${pad2(month)}${pad2(dayNum)}`;

    const cellHtml = $(cell).html() || "";
    const joined = normalizeHtmlToTextKeepingYa(cellHtml);

    if (!(joined.includes("조식") || joined.includes("중식") || joined.includes("석식"))) continue;

    const breakfast = extractMealFromText(joined, "조식");
    const lunch = extractMealFromText(joined, "중식");
    const dinnerAll = extractMealFromText(joined, "석식");
    const { dinner, late } = splitDinnerAndLate(dinnerAll);

    if (breakfast || lunch || dinner) {
      map.set(ymd, { breakfast, lunch, dinner, late });
    }
  }

  return map;
}

function parseDayMealsFromPageHtml(html) {
  // Don’t over-scope: some HAFS pages render meal blocks outside expected wrappers.
  // Use the whole HTML as text source.
  const joined = normalizeHtmlToTextKeepingYa(String(html || ""));

  const breakfast = extractMealFromText(joined, "조식");
  const lunch = extractMealFromText(joined, "중식");
  const dinnerAll = extractMealFromText(joined, "석식");
  const { dinner, late } = splitDinnerAndLate(dinnerAll);

  return { breakfast, lunch, dinner, late };
}

// ----------------- Cache -----------------
const monthHtmlCache = new Map(); // key: YYYYMM -> { html, ts }
const MONTH_TTL_MS = 10 * 60 * 1000;

const dayHtmlCache = new Map(); // key: YYYYMMDD -> { html, ts }
const DAY_TTL_MS = 5 * 60 * 1000;

// 이미지 캐시
const imageBinCache = new Map();
const IMAGE_TTL_MS = 60 * 60 * 1000;

// In-flight de-dupe (prevents multiple concurrent fetches for the same key)
const monthInFlight = new Map(); // key: YYYYMM -> Promise<html>
const dayInFlight = new Map();   // key: YYYYMMDD -> Promise<html>

async function fetchDayInfo(ymd) {
  const cached = dayHtmlCache.get(ymd);
  const now = Date.now();
  if (cached && now - cached.ts < DAY_TTL_MS) return cached.html;

  if (dayInFlight.has(ymd)) return await dayInFlight.get(ymd);

  const p = (async () => {
    const url = hafsDayUrl(ymd);
    const resp = await getHtmlArrayBuffer(url, 6000);
    const html = decodeHafsHtml(resp.data);
    dayHtmlCache.set(ymd, { html, ts: Date.now() });
    return html;
  })();

  dayInFlight.set(ymd, p);
  try {
    return await p;
  } finally {
    dayInFlight.delete(ymd);
  }
}

async function fetchDayMeals(ymd) {
  const html = await fetchDayInfo(ymd);
  const info = parseDayMealsFromPageHtml(html);
  // If everything is empty, treat as "no menu".
  if (!info.breakfast && !info.lunch && !info.dinner) return null;
  return info;
}

async function fetchMonthMapForRange(fromYmd, toYmd) {
  const yFrom = Number(fromYmd.slice(0, 4));
  const mFrom = Number(fromYmd.slice(4, 6));
  const yTo = Number(toYmd.slice(0, 4));
  const mTo = Number(toYmd.slice(4, 6));

  const keys = [{ y: yFrom, m: mFrom }];
  if (!(yFrom === yTo && mFrom === mTo)) keys.push({ y: yTo, m: mTo });

  const maps = [];
  for (const { y, m } of keys) {
    const cacheKey = `${y}${pad2(m)}`;
    const cached = monthHtmlCache.get(cacheKey);
    const now = Date.now();

    let html;
    if (cached && now - cached.ts < MONTH_TTL_MS) {
      html = cached.html;
    } else {
      const anyDay = `${y}${pad2(m)}01`;
      const url = hafsMonthUrl(anyDay);

      if (monthInFlight.has(cacheKey)) {
        html = await monthInFlight.get(cacheKey);
      } else {
        const p = (async () => {
          const resp = await getHtmlArrayBuffer(url, 6000);
          return decodeHafsHtml(resp.data);
        })();
        monthInFlight.set(cacheKey, p);
        try {
          html = await p;
        } finally {
          monthInFlight.delete(cacheKey);
        }
      }

      monthHtmlCache.set(cacheKey, { html, ts: Date.now() });
    }

    maps.push(parseMonthMeals(html, y, m));
  }

  const merged = new Map();
  for (const mp of maps) {
    for (const [k, v] of mp.entries()) merged.set(k, v);
  }

  // filter
  const out = new Map();
  for (const [k, v] of merged.entries()) {
    if (k >= fromYmd && k <= toYmd) out.set(k, v);
  }

  // ✅ Fallback: if month parsing yielded nothing, fetch day pages directly.
  // This happens when the site layout changes and the calendar-cell parsing misses content.
  if (out.size === 0) {
    const days = [];
    // iterate inclusive YYYYMMDD range
    let cur = new Date(Number(fromYmd.slice(0, 4)), Number(fromYmd.slice(4, 6)) - 1, Number(fromYmd.slice(6, 8)));
    const end = new Date(Number(toYmd.slice(0, 4)), Number(toYmd.slice(4, 6)) - 1, Number(toYmd.slice(6, 8)));
    while (cur <= end) {
      days.push(yyyymmdd(cur));
      cur = addDays(cur, 1);
    }

    // fetch in parallel but keep it safe
    const results = await Promise.all(
      days.map(async (d) => {
        try {
          const info = await fetchDayMeals(d);
          return [d, info];
        } catch (e) {
          console.error("[day-fallback-failed]", d, e?.code || "", e?.message || e);
          return [d, null];
        }
      })
    );

    const out2 = new Map();
    for (const [d, info] of results) {
      if (info) out2.set(d, info);
    }
    return out2;
  }

  return out;
}

// ----------------- Request parsing -----------------
function parseUtter(utterRaw) {
  const utter = (utterRaw || "").trim();

  if (utter === "식단 사진 보기") {
    return { utter, when: "today", meal: "photo_from_ctx" };
  }

  // Photo request: "사진|YYYYMMDD|breakfast|lunch|dinner"
  if (utter.startsWith("사진|")) {
    const parts = utter.split("|");
    const ymd = (parts[1] || "").trim();
    const mealKey = (parts[2] || "").trim().toLowerCase();
    const okYmd = /^\d{8}$/.test(ymd);
    const okMeal = ["breakfast", "lunch", "dinner"].includes(mealKey);
    if (okYmd && okMeal) {
      return { utter, when: "today", meal: "photo", photoYmd: ymd, photoMeal: mealKey };
    }
  }

  // when
  let when = "today";
  if (utter.includes("내일")) when = "tomorrow";
  else if (utter.includes("이번주") || utter.includes("이번 주") || utter.includes("주간")) when = "week";
  else if (utter.includes("오늘")) when = "today";

  // meal
  let meal = "all";
  if (utter === "아침" || utter.includes("조식")) meal = "breakfast";
  else if (utter === "점심" || utter.includes("중식")) meal = "lunch";
  else if (utter === "저녁" || utter.includes("석식")) meal = "dinner";
  else if (utter === "오늘" || utter === "내일" || utter.includes("이번주") || utter.includes("이번 주")) meal = "all";

  return { utter, when, meal };
}
function extractPhotoLinksFromHtml(html) {
  // Returns mealKey -> absolute image URL (https://hafs.hs.kr/hosts/...) or null
  const $ = cheerio.load(String(html || ""));

  // Collect candidate popup links in DOM order
  const links = [];
  $("a[href*='lunch.image_pop'], a[onclick*='lunch.image_pop']").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") || "";
    const onclick = $el.attr("onclick") || "";
    const raw = href.includes("lunch.image_pop") ? href : onclick;
    if (!raw || !raw.includes("lunch.image_pop")) return;

    // extract img param (works for href or onclick)
    const m = raw.match(/img=([^'"\s)]+)/i);
    if (!m) return;
    const imgPath = decodeURIComponent(m[1]);

    // Determine meal by nearby text
    const scopeText = $el.closest("tr, td, div, li, table").text().replace(/\s+/g, " ").trim();
    let meal = null;
    if (scopeText.includes("조식")) meal = "breakfast";
    else if (scopeText.includes("중식")) meal = "lunch";
    else if (scopeText.includes("석식")) meal = "dinner";

    links.push({ meal, imgPath });
  });

  // Fallback: if meal couldn't be inferred, assign in order 조식/중식/석식
  const orderedMeals = ["breakfast", "lunch", "dinner"];
  let fallbackIdx = 0;
  const result = { breakfast: null, lunch: null, dinner: null };

  for (const it of links) {
    const mealKey = it.meal || orderedMeals[fallbackIdx++] || null;
    if (!mealKey) continue;
    if (result[mealKey]) continue; // keep first

    // no-image placeholder handling
    if (String(it.imgPath).includes("no_foodimg")) {
      result[mealKey] = null;
      continue;
    }

    // Build absolute image url.
    // The popup uses img=/hosts/...; real file is served under https://hafs.hs.kr/hosts/...
    const abs = it.imgPath.startsWith("/")
      ? `https://${HAFS_HOST}${it.imgPath}`
      : (it.imgPath.startsWith("http") ? it.imgPath : `https://${HAFS_HOST}/${it.imgPath}`);

    result[mealKey] = abs;
  }

  return result;
}

async function fetchMealPhotoUrl(ymd, mealKey) {
  const key = `${ymd}|${mealKey}`;
  const cached = photoUrlCache.get(key);
  const now = Date.now();

  if (cached && now - cached.ts < PHOTO_URL_TTL_MS) {
    return cached.url || null;
  }

  const html = await fetchDayInfo(ymd);
  const map = extractPhotoLinksFromHtml(html);
  const url = map?.[mealKey] || null;

  if (url) photoUrlCache.set(key, { url, ts: now });

  return url;
}

const photoUrlCache = new Map();
const PHOTO_URL_TTL_MS = 30 * 60 * 1000;

// Last meal context per Kakao user (to support "식단 사진 보기" as plain utterance)
const lastMealCtx = new Map(); // key: userId -> { ymd, mealKey, ts }
const LAST_CTX_TTL_MS = 30 * 60 * 1000;

function getUserId(req) {
  return (
    req?.body?.userRequest?.user?.id ||
    req?.body?.userRequest?.user?.properties?.appUserId ||
    ""
  );
}

function setLastMealCtx(userId, ymd, mealKey) {
  if (!userId) return;
  lastMealCtx.set(userId, { ymd, mealKey, ts: Date.now() });
}

function getLastMealCtx(userId) {
  if (!userId) return null;
  const v = lastMealCtx.get(userId);
  if (!v) return null;
  if (Date.now() - v.ts > LAST_CTX_TTL_MS) {
    lastMealCtx.delete(userId);
    return null;
  }
  return v;
}

function proxiedImageUrl(rawUrl) {
  if (!rawUrl) return null;
  return `${BASE_URL}/img?url=${encodeURIComponent(rawUrl)}`;
}

function mealKo(meal) {
  if (meal === "breakfast") return "조식";
  if (meal === "lunch") return "중식";
  if (meal === "dinner") return "석식";
  return "전체";
}

// ----------------- Routes -----------------
app.get("/", (req, res) => {
  res.status(200).send("✅ HAFS cafeteria bot (rebuild) running. POST /kakao");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Welcome/menu endpoint
app.post("/menu", (req, res) => {
  return res.json(
    kakaoText(
      "원하는 버튼을 눌러 급식을 확인해주세요.\n\n• 아침/점심/저녁: 오늘 해당 식사\n• 오늘/내일/이번주: 전체 식단",
      menuQuickReplies()
    )
  );
});

// Optional image proxy (kept for future photo features)
app.get("/img", async (req, res) => {
  try {
    const raw = String(req.query.url || "");
    if (!raw || !/^https?:\/\//i.test(raw)) return res.status(400).send("Bad url");

    const u0 = new URL(raw);
    const allowedHosts = new Set(["hafs.hs.kr"]);
    if (HAFS_IP_FALLBACK) allowedHosts.add(HAFS_IP_FALLBACK);
    if (!allowedHosts.has(u0.hostname)) return res.status(403).send("Forbidden");

    // 🔥 upstream은 HTTP를 우선 시도 (NitroEye가 https만 막는 경우가 많음)
    const candidates = [];
    const httpUrl = raw.replace(/^https:\/\//i, "http://");
    const httpsUrl = raw.replace(/^http:\/\//i, "https://");
    candidates.push(httpUrl, httpsUrl);

    const isNitro = (resp, buf) => {
      const loc = String(resp?.headers?.location || "");
      if (loc.includes("nitroeye.co.kr/404_firewall")) return true;
      const body = buf ? buf.toString("utf-8") : "";
      return body.includes("nitroeye.co.kr/404_firewall") || body.includes("404_firewall");
    };

    let lastErr = null;

    // 1) axios로 빠르게 시도
    for (const url of candidates) {
      try {
        const uu = new URL(url);
        const isIpHost = HAFS_IP_FALLBACK && uu.hostname === HAFS_IP_FALLBACK;

        const resp = await axios.get(url, {
          responseType: "arraybuffer",
          timeout: 7000,
          maxRedirects: 0, // 리다이렉트 직접 감지
          validateStatus: (s) => s >= 200 && s < 400,
          httpsAgent: isIpHost ? httpsAgentHafsIp : httpsAgent,
          httpAgent,
          headers: {
            "User-Agent": "Mozilla/5.0",
            Referer: "https://hafs.hs.kr/",
            ...(isIpHost ? { Host: "hafs.hs.kr" } : {}),
          },
        });

        const buf = Buffer.from(resp.data || []);
        // 이미지 캐시
        imageBinCache.set(url, { buf, ct: resp.headers["content-type"]    , ts: Date.now() });
        if (isNitro(resp, buf)) throw Object.assign(new Error("HAFS_FIREWALL_BLOCK"), { code: "HAFS_FIREWALL" });

        const ctRaw = String(resp.headers["content-type"] || "").toLowerCase();
        if (!ctRaw.startsWith("image/")) throw new Error("NOT_IMAGE");

        res.setHeader("Content-Type", ctRaw);
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.status(200).send(buf);
      } catch (e) {
        lastErr = e;
      }
    }

    // 2) axios가 막히면 Playwright로 “브라우저처럼” 받아오기 (이미지도 우회)
    //    (playwright 설치되어 있어야 함)
    try {
      const htmlOrBinary = await fetchHtmlWithPlaywright(raw, 15000);
      // ⚠️ playwright로는 여기서 "바이너리"를 직접 받기 어렵기 때문에
      // 이미지 URL을 브라우저가 접근 가능하게끔 만든 다음, 다시 axios로 한 번 더 시도하는 방식이 가장 안정적
      // (쿠키가 갱신되면 axios가 성공하는 케이스가 많음)

      // 쿠키 갱신된 상태로 https 재시도
      const retry = await axios.get(httpsUrl, {
        responseType: "arraybuffer",
        timeout: 7000,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://hafs.hs.kr/",
          ...(HAFS_COOKIE ? { Cookie: HAFS_COOKIE } : {}),
        },
        validateStatus: (s) => s >= 200 && s < 400,
      });

      const ctRaw = String(retry.headers["content-type"] || "").toLowerCase();
      const buf = Buffer.from(retry.data || []);
      if (!ctRaw.startsWith("image/")) throw new Error("NOT_IMAGE_AFTER_PW");

      res.setHeader("Content-Type", ctRaw);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Length", String(buf.length)); // ⭐ 이게 핵심
      return res.status(200).send(buf);
    } catch (e) {
      lastErr = e;
    }

    return res.status(404).send("Not found");
  } catch (e) {
    return res.status(404).send("Not found");
  }
});
// Kakao webhook
app.post("/kakao", async (req, res) => {
  try {
    const utter = req?.body?.userRequest?.utterance || "";
    const { when, meal } = parseUtter(utter);

    // Photo flow
    const parsed = parseUtter(utter);
    if (parsed.meal === "photo") {
      const ymd = parsed.photoYmd;
      const mealKey = parsed.photoMeal;
      const titleKo = mealKo(mealKey);

      const rawPhotoUrl = await fetchMealPhotoUrl(ymd, mealKey);
      if (!rawPhotoUrl) {
        return res.json(kakaoText("식단 사진이 없습니다.", null));
      }

      const imgUrl = proxiedImageUrl(rawPhotoUrl);
      return res.json(
        kakaoImageCard(`📷 (${prettyYmd(ymd)}) ${titleKo}`, imgUrl, `(${prettyYmd(ymd)}) ${titleKo}`, null)
      );
    }

        // Photo flow (from stored context)
    if (parsed.meal === "photo_from_ctx") {
      const userId = getUserId(req);
      const ctx = getLastMealCtx(userId);

      if (!ctx) {
        return res.json(kakaoText("먼저 아침/점심/저녁 메뉴를 확인한 뒤, 식단 사진 보기를 눌러줘!", null));
      }

      const ymd = ctx.ymd;
      const mealKey = ctx.mealKey;
      const titleKo = mealKo(mealKey);

      const rawPhotoUrl = await fetchMealPhotoUrl(ymd, mealKey);
      if (!rawPhotoUrl) {
        return res.json(kakaoText("식단 사진이 없습니다.", null));
      }

      const imgUrl = proxiedImageUrl(rawPhotoUrl);
      return res.json(
        kakaoImageCard(`📷 (${prettyYmd(ymd)}) ${titleKo}`, imgUrl, `(${prettyYmd(ymd)}) ${titleKo}`, null)
      );
    }

    // Menu for empty or unknown
    if (
  !utter ||
  !["아침", "점심", "저녁", "오늘", "내일", "이번주", "이번 주", "식단 사진 보기", "사진|"].some((k) =>
    utter.includes(k)
  )
) {
  return res.json(
    kakaoText(
      "원하는 버튼을 눌러 급식을 확인해주세요.\n\n• 아침/점심/저녁: 오늘 해당 식사\n• 오늘/내일/이번주: 전체 식단",
      menuQuickReplies()
    )
  );
}

    const now = new Date();
    let from, to;

    if (when === "tomorrow") {
      const d = addDays(now, 1);
      from = yyyymmdd(d);
      to = from;
    } else if (when === "week") {
      const monday = startOfWeekMonday(now);
      const sunday = addDays(monday, 6);
      from = yyyymmdd(monday);
      to = yyyymmdd(sunday);
    } else {
      from = yyyymmdd(now);
      to = from;
    }

    // Fetch range map via month scrape (1~2 requests)
    const rangeMap = await fetchMonthMapForRange(from, to);
    // Debug: log when nothing parsed for the requested range
    if (!rangeMap || rangeMap.size === 0) {
      console.error("[parse-empty] rangeMap empty", { from, to, when, meal, note: "will show empty if no menus OR blocked" });
    }

    // Render
    if (!rangeMap || rangeMap.size === 0) {
      return res.json(
        kakaoText(
          "해당 날짜의 급식 정보가 아직 등록되지 않았거나 제공되지 않는 날입니다."
        )
      );
    }

    // single meal
    if (meal !== "all" && from === to) {
      // Fast path for single-meal buttons: fetch just the day page and parse it.
      // This is much faster than month-range parsing under load.
      const infoFast = await fetchDayMeals(from);
      const info = infoFast || {};
      const userId = getUserId(req);
      setLastMealCtx(userId, from, meal);
      let menuText = null;
      let lateText = null;

      if (meal === "breakfast") menuText = info.breakfast || null;
      if (meal === "lunch") menuText = info.lunch || null;
      if (meal === "dinner") {
        menuText = info.dinner || null;
        lateText = info.late || null;
      }

      if (!menuText) {
        return res.json(
          kakaoText(`🍽 ${mealKo(meal)} 정보가 아직 등록되지 않았거나 오늘은 제공되지 않습니다.`, menuQuickReplies())
        );
      }

      let fullText = menuText;
      if (meal === "dinner" && lateText) fullText = `${menuText}\n\n<야식>\n${lateText}`;

      const text = `🍽 ${mealKo(meal)}\n📅 ${prettyYmd(from)}\n${fullText}`;
      return res.json(kakaoText(text, photoQuickReplies(from, meal)));
    }

    // all
    const days = [...rangeMap.keys()].sort();
    const text = days
      .map((d) => {
        const info = rangeMap.get(d) || {};
        const chunks = [];
        if (info.breakfast) chunks.push(`• 조식\n${info.breakfast}`);
        if (info.lunch) chunks.push(`• 중식\n${info.lunch}`);
        if (info.dinner) {
          let combined = `• 석식\n${info.dinner}`;
          if (info.late) combined += `\n\n<야식>\n${info.late}`;
          chunks.push(combined);
        }
        return `📅 ${prettyYmd(d)}\n${chunks.join("\n\n")}`;
      })
      .join("\n\n──────────\n\n");

    return res.json(kakaoText(text, null));
  } catch (err) {
    const code = err?.code || "";
    const msg = err?.message || "";
    console.error("KAKAO ERROR", code, msg);

    if (code === "HAFS_FIREWALL" || msg.includes("HAFS_FIREWALL")) {
      return res.json(
        kakaoText(
          "학교 사이트 접속이 차단(방화벽)되어 급식을 불러올 수 없어요.\n잠시 후 다시 시도해줘!"
        )
      );
    }
    if (code === "PLAYWRIGHT_NOT_INSTALLED" || msg.includes("PLAYWRIGHT_NOT_INSTALLED")) {
      return res.json(
        kakaoText(
          "서버에 브라우저 모듈(Playwright)이 없어 학교 사이트 차단을 우회할 수 없어요.\n관리자에게 Playwright 설치 후 재배포를 요청해줘!"
        )
      );
    }

    return res.json(kakaoText("급식 불러오다가 오류가 났어. 잠시 후 다시 시도해줘!"));
  }
});

// Run
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행중: http://localhost:${PORT}`));