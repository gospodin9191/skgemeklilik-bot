const { Telegraf } = require("telegraf");
const fs = require("fs");
const http = require("http");

const bot = new Telegraf(process.env.BOT_TOKEN);

// sgk_rules.json aynı klasörde olmalı
const rules = JSON.parse(fs.readFileSync("sgk_rules.json", "utf8"));

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      step: 0,
      data: {},
      pending: null, // { key, value, nextStep, label }
      awaitingConfirm: false,
    });
  }
  return sessions.get(id);
}

function normalizeYesNo(text) {
  const t = (text || "").trim().toLowerCase();
  if (["evet", "e", "yes", "y"].includes(t)) return "yes";
  if (["hayır", "hayir", "h", "no", "n"].includes(t)) return "no";
  return null;
}

function askConfirm(ctx, label, key, value, nextStep) {
  const s = getSession(ctx.from.id);
  s.pending = { key, value, nextStep, label };
  s.awaitingConfirm = true;
  ctx.reply(`${label}: "${value}"\nDoğru mu? (evet / hayır)`);
}

/* -----------------------------
   SGK TABLO OKUMA + KURAL SEÇME
------------------------------ */

function rowToArray(rowObj) {
  // csv-parser ile oluşmuş objelerde kolonlar "0","1","2"... olur
  const keys = Object.keys(rowObj)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));
  return keys.map((k) => (rowObj[k] ?? "").toString().trim());
}

function findNearestGenderTag(rowsArr, startIdx) {
  for (let i = startIdx; i >= 0; i--) {
    const joined = rowsArr[i].join(" ").toLowerCase();
    if (joined.includes("kadın") || joined.includes("kadin")) return "Kadın";
    if (joined.includes("erkek")) return "Erkek";
  }
  return null;
}

function parseEntryRange(text) {
  // "02.06.1984-01.06.1985" veya "01.06.1984 ve öncesi" / "sonrası"
  const t = (text || "").toString().trim();

  const mRange = t.match(/(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/);
  if (mRange) return { type: "range", start: mRange[1], end: mRange[2] };

  const mBefore = t.match(/(\d{2}\.\d{2}\.\d{4}).*(öncesi|ve\s*öncesi)/i);
  if (mBefore) return { type: "before", end: mBefore[1] };

  const mAfter = t.match(/(\d{2}\.\d{2}\.\d{4}).*(sonrası|ve\s*sonrası)/i);
  if (mAfter) return { type: "after", start: mAfter[1] };

  return null;
}

function dateToNumberTR(d) {
  // "dd.mm.yyyy" -> yyyymmdd
  const m = (d || "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yy] = m;
  return Number(`${yy}${mm}${dd}`);
}

function entryYearToApproxDateNumber(year) {
  // sadece yıl aldığımız için yaklaşık: 01.07.YYYY
  return Number(`${year}0701`);
}

function extractMainRetirementTable(statusRules) {
  const rowsArr = statusRules.map(rowToArray);

  for (let i = 0; i < rowsArr.length; i++) {
    const row = rowsArr[i];
    const idxEntry = row.findIndex((c) => c.toLowerCase().includes("işe başlangıç"));
    if (idxEntry === -1) continue;

    // Gün/Yaş kolonlarını aynı satırda ya da bir sonraki satırda ara
    const row1 = row;
    const row2 = rowsArr[i + 1] || row;

    const idxDays =
      row1.findIndex((c) => c.toLowerCase().includes("gün")) !== -1
        ? row1.findIndex((c) => c.toLowerCase().includes("gün"))
        : row2.findIndex((c) => c.toLowerCase().includes("gün"));

    const idxAge =
      row1.findIndex((c) => c.toLowerCase().includes("yaş")) !== -1
        ? row1.findIndex((c) => c.toLowerCase().includes("yaş"))
        : row2.findIndex((c) => c.toLowerCase().includes("yaş"));

    if (idxDays === -1 || idxAge === -1) continue;

    const genderTag = findNearestGenderTag(rowsArr, i);

    const extracted = [];
    for (let r = i + 1; r < rowsArr.length; r++) {
      const rr = rowsArr[r];
      const entryText = rr[idxEntry] || "";
      const range = parseEntryRange(entryText);

      const nonEmpty = rr.filter((x) => x && x !== "NaN").length;
      if (!entryText && nonEmpty < 3) break; // tablo bitti

      if (!range) continue;

      const days = Number((rr[idxDays] || "").toString().replace(/[^\d]/g, ""));
      const age = Number((rr[idxAge] || "").toString().replace(/[^\d]/g, ""));

      if (!Number.isFinite(days) || !Number.isFinite(age) || days === 0 || age === 0) continue;

      extracted.push({
        genderTag,
        range,
        requiredDays: days,
        requiredAge: age,
        raw: rr,
      });
    }

    if (extracted.length) return extracted;
  }

  return [];
}

function pickRuleByEntryYear(rulesExtracted, gender, entryYear) {
  const entryNum = entryYearToApproxDateNumber(entryYear);

  const candidates = rulesExtracted.filter((r) => !r.genderTag || r.genderTag === gender);

  for (const r of candidates) {
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

function buildReport(user, rule) {
  const nowYear = 2026; // yıl bazlı (istersen sonra gün/ay hassas yaparız)
  const ageNow = nowYear - user.birthYear;

  const missingPrim = Math.max(0, rule.requiredDays - user.prim);
  const missingAge = Math.max(0, rule.requiredAge - ageNow);

  const okPrim = missingPrim === 0;
  const okAge = missingAge === 0;
  const elig = okPrim && okAge;

  const lines = [];
  lines.push("🧾 *SGK Emeklilik Ön Raporu*");
  lines.push(`• Statü: ${user.status}`);
  lines.push(`• Cinsiyet: ${user.gender}`);
  lines.push(`• Doğum yılı: ${user.birthYear} (≈ ${ageNow} yaş)`);
  lines.push(`• İlk giriş yılı: ${user.entryYear}`);
  lines.push(`• Prim: ${user.prim}`);
  lines.push("");
  lines.push("📌 *Tablodan Bulunan Kural (Ana Yaşlılık)*");
  lines.push(`• Gerekli yaş: ${rule.requiredAge}`);
  lines.push(`• Gerekli prim: ${rule.requiredDays}`);
  lines.push("");

  if (elig) {
    lines.push("✅ *Sonuç:* Yaş + prim şartını karşılıyorsun (ana tabloya göre).");
    lines.push("🗣️ Yorum: Hizmet birleştirme/statü geçişi/borçlanma gibi istisnalar yoksa emeklilik hakkın gelmiş ya da çok yakın görünüyor.");
  } else {
    lines.push("⏳ *Sonuç:* Henüz tamam değil (ana tabloya göre).");
    if (!okPrim) lines.push(`• Eksik prim: ${missingPrim} gün`);
    if (!okAge) lines.push(`• Eksik yaş: ${missingAge} yıl`);
    lines.push("🗣️ Yorum: Şu an ana emeklilik koşulunu baz aldım. Bir sonraki adımda tabloda varsa *kısmi emeklilik* seçeneklerini de ikinci alternatif olarak göstereceğim.");
  }

  lines.push("");
  lines.push("⚠️ Not: Bu sürüm, JSON içinden otomatik yakaladığım “İşe Başlangıç / Gün / Yaş” ana bölümünden ön sonuç üretir. Kısmi/malulen/engellilik gibi diğer başlıkları sonraki adımda ekleyeceğiz.");

  return lines.join("\n");
}

/* -----------------------------
   BOT AKIŞI (ONAYLI)
------------------------------ */

bot.start((ctx) => {
  const s = getSession(ctx.from.id);
  s.step = 1;
  s.data = {};
  s.pending = null;
  s.awaitingConfirm = false;
  ctx.reply("SGK statünüz nedir? (4A / 4B / 4C)");
});

bot.on("text", (ctx) => {
  const s = getSession(ctx.from.id);
  const msg = ctx.message.text.trim();

  // Onay bekleniyorsa
  if (s.awaitingConfirm) {
    const yn = normalizeYesNo(msg);
    if (!yn) return ctx.reply('Lütfen "evet" ya da "hayır" yaz.');

    if (yn === "no") {
      s.awaitingConfirm = false;
      s.pending = null;

      if (s.step === 1) return ctx.reply("Tekrar yazalım: SGK statünüz nedir? (4A / 4B / 4C)");
      if (s.step === 2) return ctx.reply("Tekrar yazalım: Cinsiyetiniz? (Kadın / Erkek)");
      if (s.step === 3) return ctx.reply("Tekrar yazalım: Doğum yılınız? (örn 1988)");
      if (s.step === 4) return ctx.reply("Tekrar yazalım: İlk sigorta giriş yılınız? (örn 2008)");
      if (s.step === 5) return ctx.reply("Tekrar yazalım: Toplam prim gününüz? (örn 5400)");
    }

    // evet ise kaydet ve ilerle
    s.data[s.pending.key] = s.pending.value;
    s.awaitingConfirm = false;
    s.step = s.pending.nextStep;
    s.pending = null;

    // sonraki soru
    if (s.step === 2) return ctx.reply("Cinsiyetiniz? (Kadın / Erkek)");
    if (s.step === 3) return ctx.reply("Doğum yılınız? (örn 1988)");
    if (s.step === 4) return ctx.reply("İlk sigorta giriş yılınız? (örn 2008)");
    if (s.step === 5) return ctx.reply("Toplam prim gününüz? (örn 5400)");

    // hesaplama
    if (s.step === 6) {
      const statusRules = rules[s.data.status] || [];
      const extracted = extractMainRetirementTable(statusRules);

      if (!extracted.length) {
        s.step = 0;
        return ctx.reply("Bu statü için ana emeklilik tablosunu otomatik bulamadım. (Bir sonraki adımda tabloyu hedeflemeyi ekleriz.)");
      }

      const picked = pickRuleByEntryYear(extracted, s.data.gender, s.data.entryYear);
      if (!picked) {
        s.step = 0;
        return ctx.reply("Giriş yılına göre uygun kuralı bulamadım. (Tablo tarih formatı farklı olabilir; bir sonraki adımda düzeltiriz.)");
      }

      const report = buildReport(
        {
          status: s.data.status,
          gender: s.data.gender,
          birthYear: s.data.birthYear,
          entryYear: s.data.entryYear,
          prim: s.data.prim,
        },
        picked
      );

      s.step = 0;
      return ctx.reply(report, { parse_mode: "Markdown" });
    }
  }

  // normal akış
  if (s.step === 0) return ctx.reply("Başlamak için /start yaz 🙂");

  if (s.step === 1) {
    const v = msg.toUpperCase();
    if (!["4A", "4B", "4C"].includes(v)) return ctx.reply("Lütfen 4A / 4B / 4C yaz.");
    return askConfirm(ctx, "SGK statüsü", "status", v, 2);
  }

  if (s.step === 2) {
    const t = msg.toLowerCase();
    const v = t === "erkek" ? "Erkek" : t === "kadın" || t === "kadin" ? "Kadın" : null;
    if (!v) return ctx.reply("Lütfen 'Kadın' ya da 'Erkek' yaz.");
    return askConfirm(ctx, "Cinsiyet", "gender", v, 3);
  }

  if (s.step === 3) {
    const v = Number(msg);
    if (!Number.isInteger(v) || v < 1900 || v > 2010) return ctx.reply("Doğum yılını 4 haneli yaz (örn 1988).");
    return askConfirm(ctx, "Doğum yılı", "birthYear", v, 4);
  }

  if (s.step === 4) {
    const v = Number(msg);
    if (!Number.isInteger(v) || v < 1950 || v > 2030) return ctx.reply("Giriş yılını sayı yaz (örn 2008).");
    return askConfirm(ctx, "İlk sigorta giriş yılı", "entryYear", v, 5);
  }

  if (s.step === 5) {
    const v = Number(msg);
    if (!Number.isFinite(v) || v < 0 || v > 20000) return ctx.reply("Prim gününü sayı yaz (örn 5400).");
    return askConfirm(ctx, "Toplam prim günü", "prim", v, 6);
  }
});

// Telegram botu başlat
bot.launch();
console.log("Bot çalışıyor...");

// Render port binding için mini HTTP server
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("OK");
  })
  .listen(PORT, () => console.log("HTTP server port", PORT));