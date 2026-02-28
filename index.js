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
   Tarih yardımcıları (1-2 hane destekli)
------------------------------ */
function pad2(n) {
  return String(n).padStart(2, "0");
}

// dd.mm.yyyy | d.m.yyyy | dd/mm/yyyy | d/m/yyyy | dd-mm-yyyy -> dd.mm.yyyy
function normalizeDateTR(s) {
  const t = (s || "").trim();
  const m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!m) return null;
  const dd = pad2(m[1]);
  const mm = pad2(m[2]);
  const yy = m[3];
  return `${dd}.${mm}.${yy}`;
}

function dateToNumberTR(d) {
  const nd = normalizeDateTR(d);
  if (!nd) return null;
  const [dd, mm, yy] = nd.split(".");
  return Number(`${yy}${mm}${dd}`);
}

function parseEntryRange(text) {
  const raw = (text || "").toString().trim();

  // d.m.yyyy - d.m.yyyy (veya / veya -)
  const mRange = raw.match(
    /(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s*-\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/
  );
  if (mRange) {
    const start = normalizeDateTR(mRange[1]);
    const end = normalizeDateTR(mRange[2]);
    if (start && end) return { type: "range", start, end };
  }

  // d.m.yyyy ve öncesi
  const mBefore = raw.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4}).*(öncesi|ve\s*öncesi)/i);
  if (mBefore) {
    const end = normalizeDateTR(mBefore[1]);
    if (end) return { type: "before", end };
  }

  // d.m.yyyy sonrası
  const mAfter = raw.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4}).*(sonrası|ve\s*sonrası)/i);
  if (mAfter) {
    const start = normalizeDateTR(mAfter[1]);
    if (start) return { type: "after", start };
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
   Ana emeklilik kural çıkarma (başlıksız, satır içinden)
------------------------------ */
function extractMainRules(statusRules) {
  const rows = statusRules.map(rowToArray);

  let currentGender = null;
  const extracted = [];

  for (const rr of rows) {
    const joined = rr.join(" ").toLowerCase();
    if (joined.includes("kadın") || joined.includes("kadin")) currentGender = "Kadın";
    if (joined.includes("erkek")) currentGender = "Erkek";

    // satırda tarih aralığı var mı?
    let range = null;
    for (const cell of rr) {
      const r = parseEntryRange(cell);
      if (r) {
        range = r;
        break;
      }
    }
    if (!range) continue;

    // satırdaki sayıları yakala
    const nums = rr
      .map((c) => (c || "").toString().replace(/\./g, "")) // 5.975 -> 5975
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
      genderTag: currentGender, // null olabilir
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
   Kısmi emeklilik (basit yakalama)
------------------------------ */
function extractPartialRules(statusRules) {
  const rows = statusRules.map(rowToArray);

  let currentGender = null;
  const extracted = [];

  for (const rr of rows) {
    const joined = rr.join(" ").toLowerCase();
    if (joined.includes("kadın") || joined.includes("kadin")) currentGender = "Kadın";
    if (joined.includes("erkek")) currentGender = "Erkek";

    if (!joined.includes("kısmi") && !joined.includes("kismi")) continue;

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

    extracted.push({ genderTag: currentGender, requiredDays, requiredAge });
  }

  return extracted;
}

function pickAnyPartial(partials, gender) {
  const same = partials.find((p) => p.genderTag === gender);
  return same || partials[0] || null;
}

/* -----------------------------
   Rapor
------------------------------ */
function yearFromDate(dateStr) {
  const nd = normalizeDateTR(dateStr);
  if (!nd) return null;
  return Number(nd.split(".")[2]);
}

function buildReport(user, mainRule, partialRule) {
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
    lines.push("🗣️ Yorum: Büyük ihtimalle tabloda tarih biçimi tek haneli gün/ay veya farklı aralık yazımıydı; şimdi bunu güçlendirdik. Eğer yine olmazsa, bir sonraki adımda bot ‘yakalanan tarih aralıklarını’ debug olarak listeleyip 1 dakikada kesin bağlarız.");
    return lines.join("\n");
  }

  const missPrimMain = Math.max(0, mainRule.requiredDays - user.prim);
  const missAgeMain = ageNow != null ? Math.max(0, mainRule.requiredAge - ageNow) : null;

  lines.push("📌 *1) Ana Emeklilik (Tablodaki ana koşul)*");
  lines.push(`• Gerekli prim: ${mainRule.requiredDays}`);
  lines.push(`• Gerekli yaş: ${mainRule.requiredAge}`);

  if (missAgeMain === null) {
    lines.push("⏳ Sonuç: Yaş hesaplanamadı (doğum tarihi formatını kontrol et).");
  } else if (missPrimMain === 0 && missAgeMain === 0) {
    lines.push("✅ Sonuç: *Yaş + prim şartı tamam görünüyor.*");
    lines.push("🗣️ Yorum: Statü geçişi, hizmet birleştirme, borçlanma gibi ek durumlar yoksa emeklilik hakkın gelmiş/çok yakın.");
  } else {
    lines.push("⏳ Sonuç: *Henüz tamam değil.*");
    if (missPrimMain) lines.push(`• Eksik prim: ${missPrimMain} gün`);
    if (missAgeMain) lines.push(`• Eksik yaş: ${missAgeMain} yıl`);
    lines.push("🗣️ Yorum: Ana koşula göre eksik var. Kısmi emeklilik bir alternatif olabilir (aşağıda).");
  }

  lines.push("");
  lines.push("📌 *2) Kısmi Emeklilik (Alternatif)*");
  if (!partialRule) {
    lines.push("Bu statüde kısmi emeklilik satırını otomatik yakalayamadım.");
    lines.push("🗣️ Yorum: Kısmi bölüm farklı başlıkla geçiyor olabilir; anahtar kelimeleri genişletebiliriz.");
  } else {
    const missPrimP = Math.max(0, partialRule.requiredDays - user.prim);
    const missAgeP = ageNow != null ? Math.max(0, partialRule.requiredAge - ageNow) : null;

    lines.push(`• Gerekli prim: ${partialRule.requiredDays}`);
    lines.push(`• Gerekli yaş: ${partialRule.requiredAge}`);

    if (missAgeP === null) {
      lines.push("⏳ Sonuç: Yaş hesaplanamadı.");
    } else if (missPrimP === 0 && missAgeP === 0) {
      lines.push("✅ Sonuç: *Kısmi için uygun görünüyor.*");
      lines.push("🗣️ Yorum: Ana emeklilik olmuyorsa, kısmi seçenek bazı kişilerde çıkış yolu oluyor.");
    } else {
      lines.push("⏳ Sonuç: *Kısmi için de eksik var.*");
      if (missPrimP) lines.push(`• Eksik prim: ${missPrimP} gün`);
      if (missAgeP) lines.push(`• Eksik yaş: ${missAgeP} yıl`);
      lines.push("🗣️ Yorum: Kısmi emeklilikte ayrıca sigortalılık süresi gibi şartlar olabilir; onu da sonraki adımda net hesaplarız.");
    }
  }

  lines.push("");
  lines.push("⚠️ Not: Bu rapor, yüklediğin tablodan otomatik okuma ile üretilen ön sonuçtur. Statü geçişleri, hizmet birleştirme, borçlanma vb. durumlarda sonuç değişebilir.");

  return lines.join("\n");
}

/* -----------------------------
   BOT AKIŞI (ONAYSIZ, TARİH ÖRNEKLİ)
------------------------------ */
bot.start((ctx) => {
  const s = getSession(ctx.from.id);
  s.step = 1;
  s.data = {};
  ctx.reply("SGK statünüz nedir? (4A / 4B / 4C)");
});

bot.on("text", (ctx) => {
  const s = getSession(ctx.from.id);
  const msg = ctx.message.text.trim();

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

    const partialExtracted = extractPartialRules(statusRules);
    const partialPicked = pickAnyPartial(partialExtracted, s.data.gender);

    const report = buildReport(
      {
        status: s.data.status,
        gender: s.data.gender,
        birthDate: s.data.birthDate,
        entryDate: s.data.entryDate,
        prim: s.data.prim,
      },
      mainPicked,
      partialPicked
    );

    s.step = 0;
    return ctx.reply(report, { parse_mode: "Markdown" });
  }
});

// Bot + Render port
bot.launch();
console.log("Bot çalışıyor...");

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("OK");
  })
  .listen(PORT, () => console.log("HTTP server port", PORT));