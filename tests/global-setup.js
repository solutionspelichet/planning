const fs = require('fs');
const path = require('path');

// Each run uses its own directory (see playwright.config.js), so the suite
// always starts from a clean, seeded state without ever deleting a database
// the webServer might already be using. This only sweeps out directories
// left behind by earlier runs.
module.exports = async () => {
  const base = path.join(__dirname, '.tmp-data');
  if (!fs.existsSync(base)) return;
  const current = process.env.PLANNING_TEST_DATA_DIR;
  for (const entry of fs.readdirSync(base)) {
    const full = path.join(base, entry);
    if (full !== current) fs.rmSync(full, { recursive: true, force: true });
  }
};
