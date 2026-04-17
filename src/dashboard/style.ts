export const DASHBOARD_CSS = `
:root {
  --bg: #0a0a0a;
  --bg-raised: #141414;
  --bg-input: #1a1a1a;
  --border: #2a2a2a;
  --text: #c8c8c8;
  --text-muted: #787878;
  --accent: #5b9a8b;
  --accent-hover: #7bc4b2;
  --danger: #c75050;
  --danger-hover: #e06060;
  --success: #5b9a5b;
  --font: "SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
  background: var(--bg);
  min-height: 100vh;
}

header {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 12px 32px;
  background: var(--bg-raised);
  border-bottom: 1px solid var(--border);
}

header .brand {
  font-size: 16px;
  color: var(--accent);
  font-weight: bold;
  flex-shrink: 0;
}

nav {
  display: flex;
  gap: 4px;
}

nav a {
  padding: 6px 12px;
  color: var(--text-muted);
  text-decoration: none;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}

nav a:hover { color: var(--text); background: var(--bg); }
nav a.active { color: var(--accent); background: var(--bg); }
nav a.muted { opacity: 0.4; }

main {
  padding: 24px 32px;
  max-width: 960px;
  margin: 0 auto;
  overflow-x: auto;
}

h1 { font-size: 20px; margin-bottom: 16px; color: var(--text); font-weight: 600; }
h2 { font-size: 16px; margin: 24px 0 12px; color: var(--text); font-weight: 600; }

table {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
}

th {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 2px solid var(--border);
  color: var(--text-muted);
  font-weight: 500;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.fingerprint {
  cursor: pointer;
  border-bottom: 1px dashed var(--text-muted);
}
.fingerprint:hover { color: var(--accent); }
.fingerprint::after { content: " \\2398"; font-size: 11px; color: var(--text-muted); }

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}
.status-dot.green { background: var(--success); }
.status-dot.gray { background: var(--text-muted); }

pre {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 16px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
  margin: 12px 0;
}

form {
  display: flex;
  gap: 8px;
  align-items: end;
  margin: 16px 0;
  flex-wrap: wrap;
}

label {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

input[type="text"] {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 10px;
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
}
input[type="text"]:focus {
  outline: none;
  border-color: var(--accent);
}

button, .btn {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 14px;
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
button:hover { border-color: var(--accent); color: var(--accent); }
button.danger { color: var(--danger); }
button.danger:hover { border-color: var(--danger-hover); color: var(--danger-hover); }
button.primary { border-color: var(--accent); color: var(--accent); }
button.primary:hover { background: var(--accent); color: var(--bg); }

.info-grid {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 4px 16px;
  margin: 12px 0;
}
.info-grid dt { color: var(--text-muted); }
.info-grid dd { color: var(--text); }

.placeholder {
  color: var(--text-muted);
  padding: 48px 0;
  text-align: center;
  font-style: italic;
}

.toast {
  position: fixed;
  bottom: 16px;
  right: 16px;
  background: var(--bg-raised);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 8px 16px;
  color: var(--accent);
  font-size: 13px;
  opacity: 0;
  transition: opacity 0.3s;
}
.toast.show { opacity: 1; }
`;
