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

/* -----------------------------
   Tarih yardımcıları
------------------------------ */
function pad2(n) {
  return String(n).padStart(2, "0");
}

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

  // 1) d.m.yyyy - d.m.yyyy
  const mRange = raw.match(
    /(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s*-\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/
  );
  if (mRange) {
    const start = normalizeDateTR(mRange[1]);
    const end = normalizeDateTR(mRange[2]);
    if (start && end) return { type: "range", start, end, raw };
  }

  // 2) d.m.yyyy öncesi / sonrası
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

  // 3) Fallback: sadece yıl aralığı "2000-2008" veya "2008 sonrası" gibi
  const yRange = raw.match(/(19\d{2}|20\d{2})\s*-\s*(19\d{2}|20\d{2})/);
  if (yRange) {
    const start = `01.01.${yRange[1]}`;
    const end = `31.12.${yRange[2]}`;
    return { type: "range", start, end, raw };
  }

  const yBefore = raw.match(/(19\d{2}|20\d{2}).*(öncesi|ve\s*öncesi)/i);
  if (yBefore) {
    const end = `31.12.${yBefore[1]}`;
    return { type: "before", end, raw };
  }

  const yAfter = raw.match(/(19\d{2}|20\d{2}).*(sonrası|ve\s*sonrası)/i);
  if (yAfter) {
    const start = `01.01.${yAfter[1]}`;
    return { type: "after", start, raw };
  }

  return null;
}

/* -----------------------------
   JSON satırlarını diziye çevirme
------------------------------ */
function rowToArray(rowObj) {
  const keys = Object.keys(rowObj)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));
  return keys.map((k) => (rowObj[k] ?? "").toString().trim());
}

/* -----------------------------
   Ana emeklilik kural çıkarma (başlıksız)
------------------------------ */
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
      if (r) {
        range = r;
        break;
      }
    }
    if (!range) continue;

    const nums = rr
      .map((c) => (c || "").toString().replace(/\./g, ""))
      .map((t) => t.match(/\d+/g) || [])
      .flat()
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n));

    const dayCandidates = nums.filter((n) => n >= 3000 && n <= 20000);
    const ageCandidates = nums.filter((n) => n >= 38 && n <= 80);

    const requiredDays = dayCandidates.length ? Math.max(...dayCandidates) : null;
    const requiredAge = ageCandidates.length ? Math.min(...ageCandidates) : null;

    if (!requiredDays || !requiredAge) continue;

    extracted.push({
      genderTag: currentGender,
      range,
      requiredDays,
      requiredAge,
    });
  }

  return extracted;
}

function pickRuleByEntryDate(rulesExtracted, gender, entryDateStr) {
  const entryNum = dateToNumberTR(entryDateStr);
  if (!entryNum) return null;

  const ordered = [
    ...rulesExtracted.filter((r) => r.genderTag === gender),
    ...rulesExtracted.filter((r) => !r.genderTag),
    ...rulesExtracted.filter((r) => r.genderTag && r.genderTag !== gender),
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

/* -----------------------------
   Debug: yakalanan tarih ifadeleri
------------------------------ */
function debugRanges(statusRules, limit = 15) {
  const rows = statusRules.map(rowToArray);
  const found = [];
  for (const rr of rows) {
    for (const cell of rr) {
      const r = parseEntryRange(cell);
      if (r) {
        found.push(r.raw || cell);
        if (found.length >= limit) return found;
      }
    }
  }
  return found;
}

/* -----------------------------
   Rapor
------------------------------ */
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
    lines.push("🧪 Çözüm: /debug yaz → bot tablodan yakaladığı tarih satırlarını gösterecek. Oradan regex’i 1 hamlede netleştiririz.");
    return lines.join("\n");
  }

  const missPrimMain = Math.max(0, mainRule.requiredDays - user.prim);
  const missAgeMain = ageNow != null ? Math.max(0, mainRule.requiredAge - ageNow) : null;

  lines.push("📌 *Ana Emeklilik (Tablodaki ana koşul)*");
  lines.push(`• Gerekli prim: ${mainRule.requiredDays}`);
  lines.push(`• Gerekli yaş: ${mainRule.requiredAge}`);

  if (missAgeMain === null) {
    lines.push("⏳ Sonuç: Yaş hesaplanamadı (doğum tarihi formatını kontrol et).");
  } else if (missPrimMain === 0 && missAgeMain === 0) {
    lines.push("✅ Sonuç: *Yaş + prim şartı tamam görünüyor.*");
  } else {
    lines.push("⏳ Sonuç: *Henüz tamam değil.*");
    if (missPrimMain) lines.push(`• Eksik prim: ${missPrimMain} gün`);
    if (missAgeMain) lines.push(`• Eksik yaş: ${missAgeMain} yıl`);
  }

  return lines.join("\n");
}

/* -----------------------------
   Bot komutları
------------------------------ */
bot.start((ctx) => {
  const s = getSession(ctx.from.id);
  s.step = 1;
  s.data = {};
  ctx.reply("SGK statünüz nedir? (4A / 4B / 4C)");
});

bot.command("debug", (ctx) => {
  const s = getSession(ctx.from.id);
  const status = (s.data.status || "4A").toUpperCase();
  const statusRules = rules[status] || [];
  const found = debugRanges(statusRules, 15);

  if (!found.length) {
    return ctx.reply(
      `DEBUG (${status}): Hiç tarih ifadesi yakalayamadım.\n` +
      `Büyük ihtimalle tabloda tarih yerine farklı bir yazım var (örn: 08/09/1999 yerine 8 Eylül 1999 gibi).\n` +
      `Bana tabloda “işe başlangıç” satırlarından bir örnek metni yazarsan regex’i ona göre güncellerim.`
    );
  }

  return ctx.reply(
    `DEBUG (${status}): İlk ${found.length} tarih ifadesi:\n- ` + found.join("\n- ")
  );
});

bot.on("text", (ctx) => {
  const s = getSession(ctx.from.id);
  const msg = ctx.message.text.trim();

  if (msg === "/debug") return; // komut zaten yakalandı

  if (s.step === 0) return ctx.reply("Başlamak için /start yaz 🙂");

  if (s.step === 1) {
    const v = msg.toUpperCase();
    if (!["4A", "4B", "4C"].includes(v)) return ctx.reply("Lütfen 4A / 4B / 4C yaz.");
    s.data.status = v;
    s.step = 2;
    return ctx.reply("Cinsiyetiniz nedir? (Kadın / Erkek)");
  }

  if (s.step === 2) {
    const t = msg.toLowerCase();
    const v = t === "erkek" ? "Erkek" : t === "kadın" || t === "kadin" ? "Kadın" : null;
    if (!v) return ctx.reply("Lütfen 'Kadın' ya da 'Erkek' yaz.");
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
      {
        status: s.data.status,
        gender: s.data.gender,
        birthDate: s.data.birthDate,
        entryDate: s.data.entryDate,
        prim: s.data.prim,
      },
      mainPicked
    );

    s.step = 0;
    return ctx.reply(report, { parse_mode: "Markdown" });
  }
});

// Bot + Render port
bot.launch();
console.log("Bot çalışıyor...");

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
}).listen(PORT, () => console.log("HTTP server port", PORT));