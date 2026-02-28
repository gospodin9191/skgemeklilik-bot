const fs = require("fs");
const csv = require("csv-parser");

const statuses = ["4a_clean_utf8bom.csv", "4b_clean_utf8bom.csv", "4c_clean_utf8bom.csv"];
const result = { "4A": [], "4B": [], "4C": [] };

function parseFile(file, key) {
  return new Promise((resolve) => {
    fs.createReadStream(file)
      .pipe(csv({ separator: "," }))
      .on("data", (row) => {
        result[key].push(row);
      })
      .on("end", resolve);
  });
}

(async () => {
  await parseFile("4a_clean_utf8bom.csv", "4A");
  await parseFile("4b_clean_utf8bom.csv", "4B");
  await parseFile("4c_clean_utf8bom.csv", "4C");

  fs.writeFileSync("sgk_rules.json", JSON.stringify(result, null, 2));
  console.log("Kurallar JSON'a aktarıldı.");
})();