import fs from "fs";
const file = "dist/bin/cli.js";
const src = fs.readFileSync(file, "utf-8");
if (!src.startsWith("#!")) {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${src}`);
}
fs.chmodSync(file, 0o755);
