const { Telegraf } = require("telegraf");
const fs = require("fs");
const http = require("http");

const bot = new Telegraf(process.env.BOT_TOKEN);
const rules = JSON.parse(fs.readFileSync("sgk_rules.json", "utf8"));

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      step: 0,
      data: {},
      pending: null,
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
  const m = (d || "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yy] = m;
  return Number(`${yy}${mm}${dd}`);
}

function entryYearToApproxDateNumber(year) {
  return Number(`${year}0701`);
}

function extractMainRetirementTable(statusRules) {
  const rowsArr = statusRules.map(rowToArray);

  for (let i = 0; i < rowsArr.length; i++) {
    const row = rowsArr[i];
    const idxEntry = row.findIndex((c) => c.toLowerCase().includes("işe başlangıç"));
    if (idxEntry === -1) continue;

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
      if (!entryText && nonEmpty < 3) break;

      if (!range) continue;

      const days = Number((rr[idxDays] || "").toString().replace(/[^\d]/g, ""));
      const age = Number((rr[idxAge] || "").toString().replace(/[^\d]/g, ""));

      if (!Number.isFinite(days) || !Number.isFinite(age) || days === 0 || age === 0) continue;

      extracted.push({ genderTag, range, requiredDays: days, requiredAge: age, raw: rr });
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

/* -----------------------------
   KISMI EMEKLİLİK (ALTERNATİF)
   - “kısmi” geçen bölümde Sigortalılık Süresi/Yıl + Yaş + Gün arar
------------------------------ */

function parseYearsText(cell) {
  // "14 yıldan fazla – 15 yıl ve daha az" => min=15 (yaklaşık), max=15
  const t = (cell || "").toLowerCase();

  // "15 yıl ve daha az"
  const mMax = t.match(/(\d+)\s*yıl\s*ve\s*daha\s*az/);
  if (mMax) return { minYears: null, maxYears: Number(mMax[1]) };

  // "15 yıl ve daha fazla"
  const mMin = t.match(/(\d+)\s*yıl\s*ve\s*daha\s*fazla/);
  if (mMin) return { minYears: Number(mMin[1]), maxYears: null };

  // "14 yıldan fazla – 21 yıl 6 ay ve daha az" gibi (ayı şimdilik yok sayıyoruz)
  const mRange = t.match(/(\d+)\s*yıl.*-\s*(\d+)\s*yıl/);
  if (mRange) return { minYears: Number(mRange[1]) + 1, maxYears: Number(mRange[2]) };

  // tek sayı yakala
  const mAny = t.match(/(\d+)\s*yıl/);
  if (mAny) return { minYears: Number(mAny[1]), maxYears: Number(mAny[1]) };

  return null;
}

function extractPartialRetirementTable(statusRules) {
  const rowsArr = statusRules.map(rowToArray);

  // "kısmi" geçen yerden itibaren tablo arayacağız
  for (let i = 0; i < rowsArr.length; i++) {
    const joined = rowsArr[i].join(" ").toLowerCase();
    if (!joined.includes("kısmi") && !joined.includes("kismi")) continue;

    // yakındaki başlıklarda "sigortal" veya "süre" veya "yıl" + "yaş" + "gün" ara
    let headerIdx = i;
    for (let k = i; k < Math.min(i + 8, rowsArr.length); k++) {
      const row = rowsArr[k].join(" ").toLowerCase();
      const hasYears = row.includes("sigortal") || row.includes("süre") || row.includes("yıl") || row.includes("yil");
      const hasAge = row.includes("yaş") || row.includes("yas");
      const hasDays = row.includes("gün") || row.includes("gun");
      if (hasYears && hasAge && hasDays) {
        headerIdx = k;
        break;
      }
    }

    const headerRow = rowsArr[headerIdx];
    const idxYears = headerRow.findIndex((c) => {
      const t = c.toLowerCase();
      return t.includes("sigortal") || t.includes("süre") || t.includes("yıl") || t.includes("yil");
    });
    const idxAge = headerRow.findIndex((c) => c.toLowerCase().includes("yaş") || c.toLowerCase().includes("yas"));
    const idxDays = headerRow.findIndex((c) => c.toLowerCase().includes("gün") || c.toLowerCase().includes("gun"));

    if (idxYears === -1 || idxAge === -1 || idxDays === -1) continue;

    const genderTag = findNearestGenderTag(rowsArr, headerIdx);

    const extracted = [];
    for (let r = headerIdx + 1; r < rowsArr.length; r++) {
      const rr = rowsArr[r];
      const yearsCell = rr[idxYears] || "";
      const nonEmpty = rr.filter((x) => x && x !== "NaN").length;
      if (!yearsCell && nonEmpty < 3) break;

      const yearsRange = parseYearsText(yearsCell);
      if (!yearsRange) continue;

      const age = Number((rr[idxAge] || "").toString().replace(/[^\d]/g, ""));
      const days = Number((rr[idxDays] || "").toString().replace(/[^\d]/g, ""));
      if (!Number.isFinite(age) || !Number.isFinite(days) || age === 0 || days === 0) continue;

      extracted.push({
        genderTag,
        yearsRange,
        requiredAge: age,
        requiredDays: days,
        raw: rr,
      });
    }

    if (extracted.length) return extracted;
  }

  return [];
}

function pickPartialRule(partials, gender, insuranceYearsApprox) {
  const candidates = partials.filter((p) => !p.genderTag || p.genderTag === gender);

  // insuranceYearsApprox aralığa uyuyorsa onu seç; yoksa en yakın alt sınırı seç
  for (const p of candidates) {
    const minY = p.yearsRange.minYears;
    const maxY = p.yearsRange.maxYears;

    const okMin = minY == null ? true : insuranceYearsApprox >= minY;
    const okMax = maxY == null ? true : insuranceYearsApprox <= maxY;

    if (okMin && okMax) return p;
  }

  // fallback: en yüksek minYears <= insuranceYearsApprox
  let best = null;
  for (const p of candidates) {
    const minY = p.yearsRange.minYears ?? -Infinity;
    if (minY <= insuranceYearsApprox) {
      if (!best || (best.yearsRange.minYears ?? -Infinity) < minY) best = p;
    }
  }
  return best;
}

/* -----------------------------
   RAPOR
------------------------------ */

function buildFullReport(user, mainRule, partialRule) {
  const nowYear = 2026; // istersen sonra gerçek tarihe çeviririz
  const ageNow = nowYear - user.birthYear;
  const insuranceYearsApprox = Math.max(0, nowYear - user.entryYear);

  const lines = [];
  lines.push("🧾 *SGK Emeklilik Raporu*");
  lines.push(`• Statü: ${user.status}`);
  lines.push(`• Cinsiyet: ${user.gender}`);
  lines.push(`• Doğum yılı: ${user.birthYear} (≈ ${ageNow} yaş)`);
  lines.push(`• İlk giriş yılı: ${user.entryYear} (≈ ${insuranceYearsApprox} yıl sigortalılık)`);
  lines.push(`• Prim: ${user.prim}`);
  lines.push("");

  // ANA
  const missPrimMain = Math.max(0, mainRule.requiredDays - user.prim);
  const missAgeMain = Math.max(0, mainRule.requiredAge - ageNow);
  const okMain = missPrimMain === 0 && missAgeMain === 0;

  lines.push("📌 *1) Ana Emeklilik (Tablodaki ana koşul)*");
  lines.push(`• Gerekli yaş: ${mainRule.requiredAge}`);
  lines.push(`• Gerekli prim: ${mainRule.requiredDays}`);
  if (okMain) {
    lines.push("✅ Sonuç: *Uygun görünüyorsun* (yaş + prim tamam).");
    lines.push("🗣️ Yorum: Statü geçişi, hizmet birleştirme, borçlanma gibi detaylar yoksa emeklilik hakkın gelmiş/çok yakın.");
  } else {
    lines.push("⏳ Sonuç: *Henüz tamam değil.*");
    if (missPrimMain) lines.push(`• Eksik prim: ${missPrimMain} gün`);
    if (missAgeMain) lines.push(`• Eksik yaş: ${missAgeMain} yıl`);
    lines.push("🗣️ Yorum: Ana koşula göre eksiklerin var. Ama kısmi emeklilik bir alternatif olabilir (aşağıda).");
  }
  lines.push("");

  // KISMI
  if (partialRule) {
    const missPrimP = Math.max(0, partialRule.requiredDays - user.prim);
    const missAgeP = Math.max(0, partialRule.requiredAge - ageNow);

    const minY = partialRule.yearsRange.minYears;
    const maxY = partialRule.yearsRange.maxYears;

    const okMinY = minY == null ? true : insuranceYearsApprox >= minY;
    const okMaxY = maxY == null ? true : insuranceYearsApprox <= maxY;
    const okYears = okMinY && okMaxY;

    const okPartial = okYears && missPrimP === 0 && missAgeP === 0;

    lines.push("📌 *2) Kısmi Emeklilik (Alternatif)*");
    lines.push(
      `• Sigortalılık süresi şartı: ${
        minY != null && maxY != null ? `${minY}–${maxY} yıl` : minY != null ? `${minY}+ yıl` : maxY != null ? `≤ ${maxY} yıl` : "—"
      }`
    );
    lines.push(`• Gerekli yaş: ${partialRule.requiredAge}`);
    lines.push(`• Gerekli prim: ${partialRule.requiredDays}`);

    if (okPartial) {
      lines.push("✅ Sonuç: *Kısmi emeklilik için uygun görünüyorsun.*");
      lines.push("🗣️ Yorum: Ana emeklilik olmuyorsa bile, kısmi emeklilik bazı durumlarda çıkış yolu olabilir.");
    } else {
      lines.push("⏳ Sonuç: *Kısmi emeklilikte de eksik var.*");
      if (!okYears) {
        lines.push("• Sigortalılık süresi: aralığa tam uymuyor (yaklaşık yıl hesabı yaptım).");
      }
      if (missPrimP) lines.push(`• Eksik prim: ${missPrimP} gün`);
      if (missAgeP) lines.push(`• Eksik yaş: ${missAgeP} yıl`);
      lines.push("🗣️ Yorum: İstersen bir sonraki adımda daha net olması için “ilk giriş tarihi (gün/ay/yıl)” da alıp yıl hesabını kesinleştiririz.");
    }

    lines.push("");
  } else {
    lines.push("📌 *2) Kısmi Emeklilik (Alternatif)*");
    lines.push("Bu statü sayfasında kısmi emeklilik tablosunu otomatik yakalayamadım.");
    lines.push("🗣️ Yorum: İstersen bir sonraki adımda tabloda kısmi bölümün başladığı satırı birlikte işaretleyip %100 doğru bağlarız.");
    lines.push("");
  }

  lines.push("⚠️ Not: Bu rapor, yüklediğin tablodan otomatik okuma ile üretilen bir hesaplamadır. Statü geçişleri, hizmet birleştirme, borçlanma, fiili hizmet zammı vb. durumlarda sonuç değişebilir.");

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

    // evet: kaydet ve ilerle
    s.data[s.pending.key] = s.pending.value;
    s.awaitingConfirm = false;
    s.step = s.pending.nextStep;
    s.pending = null;

    if (s.step === 2) return ctx.reply("Cinsiyetiniz? (Kadın / Erkek)");
    if (s.step === 3) return ctx.reply("Doğum yılınız? (örn 1988)");
    if (s.step === 4) return ctx.reply("İlk sigorta giriş yılınız? (örn 2008)");
    if (s.step === 5) return ctx.reply("Toplam prim gününüz? (örn 5400)");

    // hesap
    if (s.step === 6) {
      const statusRules = rules[s.data.status] || [];

      const mainExtracted = extractMainRetirementTable(statusRules);
      if (!mainExtracted.length) {
        s.step = 0;
        return ctx.reply("Bu statü için ana emeklilik tablosunu otomatik bulamadım. (Bir sonraki adımda tabloyu hedeflemeyi ekleriz.)");
      }
      const mainPicked = pickRuleByEntryYear(mainExtracted, s.data.gender, s.data.entryYear);
      if (!mainPicked) {
        s.step = 0;
        return ctx.reply("Giriş yılına göre ana kuralı bulamadım. (Tablo tarih formatı farklı olabilir; düzeltiriz.)");
      }

      const partialExtracted = extractPartialRetirementTable(statusRules);
      const insuranceYearsApprox = Math.max(0, 2026 - s.data.entryYear);
      const partialPicked =
        partialExtracted.length ? pickPartialRule(partialExtracted, s.data.gender, insuranceYearsApprox) : null;

      const report = buildFullReport(
        {
          status: s.data.status,
          gender: s.data.gender,
          birthYear: s.data.birthYear,
          entryYear: s.data.entryYear,
          prim: s.data.prim,
        },
        mainPicked,
        partialPicked
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