// Prints the CHANGELOG.md section for a version (default: package.json's),
// for the GitHub Release body. Exits 1 if there is none, so a release can't
// ship without a changelog entry.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const version = (process.argv[2] || require(path.join(root, 'package.json')).version).replace(/^v/, '');
const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n');
const heading = (l) => /^## /.test(l);
// The version a heading names: "## 1.2.3 - date", "## [1.2.3]", "## v1.2.3". Compared as text, so nothing in the argument is a pattern.
const versionOf = (l) => /^## \[?v?([^\]\s]+)\]?(\s|$)/.exec(l)?.[1];
const start = lines.findIndex((l) => versionOf(l) === version);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section. Add one before releasing.`);
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && heading(l));
const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
if (!body) {
  console.error(`The CHANGELOG.md section for ${version} is empty.`);
  process.exit(1);
}
console.log(body);
