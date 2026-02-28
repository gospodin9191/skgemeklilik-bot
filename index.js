const { Telegraf } = require("telegraf");
const fs = require("fs");
const http = require("http");

const bot = new Telegraf(process.env.BOT_TOKEN);
const rules = JSON.parse(fs.readFileSync("sgk_rules.json", "utf8"));

const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { step: 0, data: {} });
  return sessions.get(id);
}

/* --------- Helpers: dates --------- */
function pad2(n) { return String(n).padStart(2, "0"); }

function normalizeDateTR(s) {
  const t = (s || "").trim();
  const m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!m) return null;
  return `${pad2(m[1])}.${pad2(m[2])}.${m[3]}`;
}

function dateToNumberTR(d) {
  const nd = normalizeDateTR(d);
  if (!nd) return null;
  const [dd, mm, yy] = nd.split(".");
  return Number(`${yy}${mm}${dd}`);
}

function parseEntryRange(text) {
  const raw = (text || "").toString().trim();

  const mRange = raw.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s*-\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/);
  if (mRange) {
    const start = normalizeDateTR(mRange[1]);
    const end = normalizeDateTR(mRange[2]);
    if (start && end) return { type: "range", start, end, raw };
  }

  const mBefore = raw.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4}).*(öncesi|ve\s*öncesi)/i);
  if (mBefore) {
    const end = normalizeDateTR(mBefore[1]);
    if (end) return { type: "before", end, raw };
  }

  const mAfter = raw.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4}).*(sonrası|ve\s*sonrası)/i);
  if (mAfter) {
    const start = normalizeDateTR(mAfter[1]);
    if (start) return { type: "after", start, raw };
  }

  // year fallback
  const yRange = raw.match(/(19\d{2}|20\d{2})\s*-\s*(19\d{2}|20\d{2})/);
  if (yRange) return { type: "range", start: `01.01.${yRange[1]}`, end: `31.12.${yRange[2]}`, raw };

  const yBefore = raw.match(/(19\d{2}|20\d{2}).*(öncesi|ve\s*öncesi)/i);
  if (yBefore) return { type: "before", end: `31.12.${yBefore[1]}`, raw };

  const yAfter = raw.match(/(19\d{2}|20\d{2}).*(sonrası|ve\s*sonrası)/i);
  if (yAfter) return { type: "after", start: `01.01.${yAfter[1]}`, raw };

  return null;
}

/* --------- Helpers: row reading --------- */
function rowToArray(rowObj) {
  // 1) numeric keys "0","1","2"...
  const numKeys = Object.keys(rowObj).filter(k => /^\d+$/.test(k)).sort((a,b)=>Number(a)-Number(b));
  if (numKeys.length) return numKeys.map(k => (rowObj[k] ?? "").toString().trim());

  // 2) otherwise values (header-based)
  return Object.values(rowObj).map(v => (v ?? "").toString().trim());
}

/* --------- Rule extraction --------- */
function extractMainRules(statusRules) {
  const rows = statusRules.map(rowToArray);
  let currentGender = null;
  const extracted = [];

  for (const rr of rows) {
    const joined = rr.join(" ").toLowerCase();
    if (joined.includes("kadın") || joined.includes("kadin")) currentGender = "Kadın";
    if (joined.includes("erkek")) currentGender = "Erkek";

    let range = null;
    for (const cell of rr) {
      const r = parseEntryRange(cell);
      if (r) { range = r; break; }
    }
    if (!range) continue;

    const nums = rr
      .map(c => (c || "").toString().replace(/\./g, ""))
      .map(t => t.match(/\d+/g) || [])
      .flat()
      .map(Number)
      .filter(n => Number.isFinite(n));

    const dayCandidates = nums.filter(n => n >= 3000 && n <= 20000);
    const ageCandidates = nums.filter(n => n >= 38 && n <= 80);

    const requiredDays = dayCandidates.length ? Math.max(...dayCandidates) : null;
    const requiredAge = ageCandidates.length ? Math.min(...ageCandidates) : null;

    if (!requiredDays || !requiredAge) continue;
    extracted.push({ genderTag: currentGender, range, requiredDays, requiredAge });
  }

  return extracted;
}

function pickRuleByEntryDate(rulesExtracted, gender, entryDateStr) {
  const entryNum = dateToNumberTR(entryDateStr);
  if (!entryNum) return null;

  const ordered = [
    ...rulesExtracted.filter(r => r.genderTag === gender),
    ...rulesExtracted.filter(r => !r.genderTag),
    ...rulesExtracted.filter(r => r.genderTag && r.genderTag !== gender),
  ];

  for (const r of ordered) {
    if (r.range.type === "range") {
      const s = dateToNumberTR(r.range.start);
      const e = dateToNumberTR(r.range.end);
      if (s && e && entryNum >= s && entryNum <= e) return r;
    }
    if (r.range.type === "before") {
      const e = dateToNumberTR(r.range.end);
      if (e && entryNum <= e) return r;
    }
    if (r.range.type === "after") {
      const s = dateToNumberTR(r.range.start);
      if (s && entryNum >= s) return r;
    }
  }
  return null;
}

function yearFromDate(dateStr) {
  const nd = normalizeDateTR(dateStr);
  if (!nd) return null;
  return Number(nd.split(".")[2]);
}

function buildReport(user, mainRule) {
  const nowYear = 2026;
  const birthY = yearFromDate(user.birthDate);
  const ageNow = birthY ? nowYear - birthY : null;

  const lines = [];
  lines.push("🧾 *SGK Raporu (Ön Değerlendirme)*");
  lines.push(`• Statü: ${user.status}`);
  lines.push(`• Cinsiyet: ${user.gender}`);
  lines.push(`• Doğum tarihi: ${user.birthDate}${ageNow != null ? ` (≈ ${ageNow} yaş)` : ""}`);
  lines.push(`• İlk sigorta girişi: ${user.entryDate}`);
  lines.push(`• Prim: ${user.prim}`);
  lines.push("");

  if (!mainRule) {
    lines.push("❗ Ana emeklilik kuralını tablodan otomatik seçemedim.");
    lines.push("🧪 Şimdi /dump ve /scan kullanacağız:");
    lines.push("• /dump = JSON satır yapısını gösterir");
    lines.push("• /scan = tarih benzeri bir şey var mı tarar");
    return lines.join("\n");
  }

  const missPrim = Math.max(0, mainRule.requiredDays - user.prim);
  const missAge = ageNow != null ? Math.max(0, mainRule.requiredAge - ageNow) : null;

  lines.push("📌 *Ana Emeklilik (Tablodaki ana koşul)*");
  lines.push(`• Gerekli prim: ${mainRule.requiredDays}`);
  lines.push(`• Gerekli yaş: ${mainRule.requiredAge}`);

  if (missAge === null) {
    lines.push("⏳ Sonuç: Yaş hesaplanamadı.");
  } else if (missPrim === 0 && missAge === 0) {
    lines.push("✅ Sonuç: *Yaş + prim şartı tamam görünüyor.*");
  } else {
    lines.push("⏳ Sonuç: *Henüz tamam değil.*");
    if (missPrim) lines.push(`• Eksik prim: ${missPrim} gün`);
    if (missAge) lines.push(`• Eksik yaş: ${missAge} yıl`);
  }

  return lines.join("\n");
}

/* -----------------------------
   BOT START
------------------------------ */
bot.start((ctx) => {
  const s = getSession(ctx.from.id);
  s.step = 1;
  s.data = {};
  ctx.reply("SGK statünüz nedir? (4A / 4B / 4C)");
});

/* -----------------------------
   TEK GİRİŞ NOKTASI: text
   /dump ve /scan her adımda çalışır
------------------------------ */
bot.on("text", (ctx) => {
  const s = getSession(ctx.from.id);
  const msg = ctx.message.text.trim();

  const lower = msg.toLowerCase();

  // ✅ /dump: ilk 2 satırı + key listesi bas
  if (lower === "/dump" || lower === "dump") {
    const status = (s.data.status || "4A").toUpperCase();
    const statusRules = rules[status] || [];
    if (!statusRules.length) return ctx.reply(`DUMP (${status}): Boş görünüyor.`);

    const r0 = statusRules[0];
    const r1 = statusRules[1] || null;

    const keys0 = Object.keys(r0);
    const sample0 = {};
    keys0.slice(0, 20).forEach(k => sample0[k] = r0[k]); // ilk 20 key yeter

    const lines = [];
    lines.push(`DUMP (${status})`);
    lines.push(`Toplam satır: ${statusRules.length}`);
    lines.push(`Satır0 key sayısı: ${keys0.length}`);
    lines.push(`Satır0 ilk keyler: ${keys0.slice(0, 25).join(", ")}`);
    lines.push("");
    lines.push("Satır0 örnek (ilk 20 alan):");
    lines.push(JSON.stringify(sample0, null, 2));

    if (r1) {
      const keys1 = Object.keys(r1);
      const sample1 = {};
      keys1.slice(0, 20).forEach(k => sample1[k] = r1[k]);
      lines.push("");
      lines.push(`Satır1 key sayısı: ${keys1.length}`);
      lines.push("Satır1 örnek (ilk 20 alan):");
      lines.push(JSON.stringify(sample1, null, 2));
    }

    // Telegram mesaj limiti için kırp
    const out = lines.join("\n");
    return ctx.reply(out.length > 3500 ? out.slice(0, 3500) + "\n... (kırpıldı)" : out);
  }

  // ✅ /scan: ilk 500 satırda tarih benzeri bir şey ara (çok geniş regex)
  if (lower === "/scan" || lower === "scan") {
    const status = (s.data.status || "4A").toUpperCase();
    const statusRules = rules[status] || [];
    if (!statusRules.length) return ctx.reply(`SCAN (${status}): Boş.`);

    const maxRows = Math.min(500, statusRules.length);
    const hits = [];

    const dateLike = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})|((19\d{2}|20\d{2})\s*-\s*(19\d{2}|20\d{2}))|(19\d{2}|20\d{2})/g;

    for (let i = 0; i < maxRows; i++) {
      const rr = rowToArray(statusRules[i]).join(" | ");
      const m = rr.match(dateLike);
      if (m && m.length) {
        hits.push(`Satır ${i}: ${m.slice(0, 6).join(", ")}  >>>  ${rr.slice(0, 120)}`);
        if (hits.length >= 15) break;
      }
    }

    if (!hits.length) {
      return ctx.reply(
        `SCAN (${status}): İlk ${maxRows} satırda date-like bir şey bulamadım.\n` +
        `Bu durumda tabloda tarih hiç yok (sadece yıl/süre gibi) veya CSV->JSON dönüşümünde metinler kayboldu.\n` +
        `Şimdi /dump çıktısı bize formatı gösterecek.`
      );
    }

    return ctx.reply(`SCAN (${status}): Bulunan örnekler:\n- ` + hits.join("\n- "));
  }

  // komutlar burada akışı bozmasın
  if (msg.startsWith("/")) return;

  if (s.step === 0) return ctx.reply("Başlamak için /start yaz 🙂");

  if (s.step === 1) {
    const v = msg.toUpperCase();
    if (!["4A", "4B", "4C"].includes(v)) return ctx.reply("Lütfen 4A / 4B / 4C yaz.");
    s.data.status = v;
    s.step = 2;
    return ctx.reply("Cinsiyetiniz nedir? (Erkek / Kadın) (kısaca: e / k)");
  }

  if (s.step === 2) {
    const t = msg.toLowerCase();
    let v = null;
    if (t.startsWith("e")) v = "Erkek";
    if (t.startsWith("k")) v = "Kadın";
    if (!v) return ctx.reply("Cinsiyet için 'Erkek' ya da 'Kadın' yazın. (kısaca: e / k)");
    s.data.gender = v;
    s.step = 3;
    return ctx.reply("Doğum tarihiniz nedir? (örn: 10.01.1988)");
  }

  if (s.step === 3) {
    const d = normalizeDateTR(msg);
    if (!d) return ctx.reply("Doğum tarihini gün.ay.yıl formatında yazın (örn: 10.01.1988)");
    s.data.birthDate = d;
    s.step = 4;
    return ctx.reply("İlk sigorta giriş tarihiniz nedir? (örn: 10.01.2020)");
  }

  if (s.step === 4) {
    const d = normalizeDateTR(msg);
    if (!d) return ctx.reply("Giriş tarihini gün.ay.yıl formatında yazın (örn: 10.01.2020)");
    s.data.entryDate = d;
    s.step = 5;
    return ctx.reply("Toplam prim gününüz kaç? (örn: 5400)");
  }

  if (s.step === 5) {
    const prim = Number(msg.replace(/[^\d]/g, ""));
    if (!Number.isFinite(prim) || prim < 0 || prim > 20000) return ctx.reply("Prim gününü sayı olarak yazın (örn: 5400)");
    s.data.prim = prim;

    const statusRules = rules[s.data.status] || [];
    const mainExtracted = extractMainRules(statusRules);
    const mainPicked = pickRuleByEntryDate(mainExtracted, s.data.gender, s.data.entryDate);

    const report = buildReport(
      { status: s.data.status, gender: s.data.gender, birthDate: s.data.birthDate, entryDate: s.data.entryDate, prim: s.data.prim },
      mainPicked
    );

    s.step = 0;
    return ctx.reply(report, { parse_mode: "Markdown" });
  }
});

/* -----------------------------
   Render port
------------------------------ */
bot.launch();
console.log("Bot çalışıyor...");

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
}).listen(PORT, () => console.log("HTTP server port", PORT));