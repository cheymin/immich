import { createServer } from 'node:http';
import { DB_CONFIG_PATH, saveDbConfig, testDbConnection, type DbConfig } from 'src/bootstrap/db-config';

const PORT = Number(process.env.IMMICH_PORT || 7860);
const HOST = process.env.IMMICH_HOST || '0.0.0.0';

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Immich — Database Setup</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0f0f0f; color: #eaeaea; padding: 24px;
  }
  .card {
    width: 100%; max-width: 520px; background: #1a1a1a; border: 1px solid #2e2e2e;
    border-radius: 14px; padding: 32px; box-shadow: 0 10px 40px rgba(0,0,0,.5);
  }
  h1 { margin: 0 0 6px; font-size: 22px; }
  p.sub { margin: 0 0 24px; color: #9a9a9a; font-size: 14px; }
  label { display:block; font-size: 13px; color:#b8b8b8; margin: 14px 0 6px; }
  input, select {
    width: 100%; padding: 10px 12px; background:#0d0d0d; border:1px solid #333;
    border-radius:8px; color:#eaeaea; font-size:14px; outline:none;
  }
  input:focus, select:focus { border-color:#4c8bf5; }
  .row { display:flex; gap:12px; }
  .row > div { flex:1; }
  .toggle { display:flex; gap:18px; margin: 4px 0 8px; font-size:14px; }
  .toggle label { margin:0; display:flex; align-items:center; gap:6px; cursor:pointer; color:#eaeaea; }
  .hidden { display:none; }
  button {
    margin-top: 22px; width:100%; padding:12px; background:#4c8bf5; color:#fff; border:0;
    border-radius:8px; font-size:15px; font-weight:600; cursor:pointer;
  }
  button:disabled { opacity:.6; cursor:default; }
  #msg { margin-top:14px; font-size:14px; min-height:20px; }
  #msg.ok { color:#3dd68c; }
  #msg.err { color:#ff6b6b; }
  small { color:#777; }
</style>
</head>
<body>
  <form class="card" id="f">
    <h1>Immich Database Setup</h1>
    <p class="sub">No database connection configured. Enter your PostgreSQL details to continue.</p>

    <div class="toggle">
      <label><input type="radio" name="mode" value="parts" checked> Connection fields</label>
      <label><input type="radio" name="mode" value="url"> Connection URL</label>
    </div>

    <div id="parts">
      <div class="row">
        <div>
          <label for="host">Host</label>
          <input id="host" name="host" placeholder="db.example.com" required>
        </div>
        <div>
          <label for="port">Port</label>
          <input id="port" name="port" type="number" value="5432">
        </div>
      </div>
      <div class="row">
        <div>
          <label for="username">Username</label>
          <input id="username" name="username" placeholder="postgres" required>
        </div>
        <div>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" placeholder="••••••">
        </div>
      </div>
      <div class="row">
        <div>
          <label for="database">Database name</label>
          <input id="database" name="database" placeholder="immich" required>
        </div>
        <div>
          <label for="ssl">SSL mode</label>
          <select id="ssl" name="ssl">
            <option value="disable">disable</option>
            <option value="prefer">prefer</option>
            <option value="require">require</option>
            <option value="verify-full">verify-full</option>
          </select>
        </div>
      </div>
    </div>

    <div id="urlbox" class="hidden">
      <label for="url">Connection URL</label>
      <input id="url" name="url" placeholder="postgres://user:pass@host:5432/db?sslmode=require">
    </div>

    <button type="submit" id="btn">Test &amp; Save</button>
    <div id="msg"></div>
    <small>Config is saved to <code>${DB_CONFIG_PATH}</code> and reused on every restart. To reconfigure, delete that file (or set <code>DB_URL</code> / <code>DB_HOSTNAME</code> env vars) and restart.</small>
  </form>

<script>
const f = document.getElementById('f');
const parts = document.getElementById('parts');
const urlbox = document.getElementById('urlbox');
const msg = document.getElementById('msg');
const btn = document.getElementById('btn');

document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', () => {
  const url = r.target.value === 'url';
  parts.classList.toggle('hidden', url);
  urlbox.classList.toggle('hidden', !url);
  document.querySelectorAll('#parts input, #parts select').forEach(i => i.required = !url);
  document.getElementById('url').required = url;
}));

f.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = ''; msg.className = '';
  btn.disabled = true; btn.textContent = 'Testing…';
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const body = mode === 'url'
    ? { url: document.getElementById('url').value.trim() }
    : {
        host: document.getElementById('host').value.trim(),
        port: Number(document.getElementById('port').value) || 5432,
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
        database: document.getElementById('database').value.trim(),
        ssl: document.getElementById('ssl').value,
      };
  try {
    const res = await fetch('/api/setup/db', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    msg.textContent = 'Connection verified. Saved. Restarting…';
    msg.className = 'ok';
    btn.textContent = 'Restarting…';
    // Server exits after this; the container restarts and boots normally.
  } catch (err) {
    msg.textContent = 'Failed: ' + (err.message || err);
    msg.className = 'err';
    btn.disabled = false; btn.textContent = 'Test & Save';
  }
});
</script>
</body>
</html>`;

/**
 * Start a minimal HTTP server that serves the first-run database configuration
 * wizard. Used only when no database connection is configured yet. After a
 * successful test + save the process exits so the container restarts with the
 * new config loaded.
 */
export function startSetupServer(): void {
  const server = createServer((req, res) => {
    const url = req.url || '/';

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && url === '/api/setup/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configured: false }));
      return;
    }

    if (req.method === 'POST' && url === '/api/setup/db') {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1 << 16) {
          req.destroy();
        }
      });
      req.on('end', async () => {
        let config: DbConfig;
        try {
          config = JSON.parse(data) as DbConfig;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        try {
          await testDbConnection(config);
          saveDbConfig(config);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          // Exit shortly after so the container restarts and boots with config.
          setTimeout(() => process.exit(0), 600);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(PORT, HOST, () => {
    console.log(`[Setup] Database configuration wizard listening on http://${HOST}:${PORT}`);
    console.log(`[Setup] No DB config found — open the URL above to configure your PostgreSQL connection.`);
  });
}
