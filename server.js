// ===== savebank-server — server.js =====
// รองรับทั้ง:
//   KBiz AutoFill v11  → /api/send, /api/poll/:name, /api/done/:id, /api/status
//   Bank Data Sender   → /api/send, /api/status
//   KBiz AutoSearch    → WebSocket register + search

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// WebSocket clients: name → ws
const clients = new Map();

// Job queue: id → { target, accountNo, bankName, sentBy, status, createdAt }
const jobs = new Map();

// ===== HTTP =====
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // ─── GET /api/status ───────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/status') {
    const online = [...clients.keys()];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, online, count: online.length }));
    return;
  }

  // ─── GET /ping (wake-up endpoint) ─────────────────────────────────
  if (req.method === 'GET' && (url === '/ping' || url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size }));
    return;
  }

  // ─── GET /api/poll/:name  (polling สำหรับ KBiz AutoFill) ──────────
  const pollMatch = url.match(/^\/api\/poll\/(.+)$/);
  if (req.method === 'GET' && pollMatch) {
    const name = decodeURIComponent(pollMatch[1]);
    // คืน job ที่ target ตรงกับชื่อ และยังไม่ได้ทำ
    const items = [...jobs.values()]
      .filter(j => j.target === name && j.status === 'pending')
      .slice(0, 5) // ส่งสูงสุด 5 งานต่อครั้ง
      .map(j => ({ id: j.id, accountNo: j.accountNo, bankName: j.bankName, sentBy: j.sentBy }));

    // mark as sent
    items.forEach(i => { if (jobs.has(i.id)) jobs.get(i.id).status = 'polled'; });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, items }));
    return;
  }

  // ─── POST /api/done/:id  (KBiz AutoFill รายงานผล) ─────────────────
  const doneMatch = url.match(/^\/api\/done\/(.+)$/);
  if (req.method === 'POST' && doneMatch) {
    const id = doneMatch[1];
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { status, message, recipientName } = JSON.parse(body || '{}');
        if (jobs.has(id)) {
          jobs.get(id).status = status || 'done';
          jobs.get(id).recipientName = recipientName || null;
          jobs.get(id).message = message || null;
          console.log(`[Done] ${id} → ${status} | ${recipientName || ''}`);
          // ลบหลัง 5 นาที
          setTimeout(() => jobs.delete(id), 300000);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  // ─── POST /api/send  (Bank Data Sender ส่งงานมา) ──────────────────
  if (req.method === 'POST' && url === '/api/send') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { target, accountNo, bankName, sentBy } = JSON.parse(body);
        if (!target || !accountNo || !bankName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing fields' }));
          return;
        }

        const id = crypto.randomUUID();
        const job = { id, target, accountNo, bankName, sentBy: sentBy || 'unknown', status: 'pending', createdAt: Date.now() };
        jobs.set(id, job);

        // ลบงานที่ค้างนาน 10 นาที
        setTimeout(() => jobs.delete(id), 600000);

        console.log(`[Send] ${sentBy} → ${target} | ${accountNo} ${bankName} | id=${id}`);

        // ถ้า target online อยู่ → ส่ง WS ทันที (KBiz AutoSearch mode)
        const targetWs = clients.get(target);
        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify({ type: 'search', id, accountNo, bankName, sentBy: sentBy || 'unknown' }));
          job.status = 'sent-ws';
        }

        // ถ้า target เป็น AutoFill (รับผ่าน job msg) → ส่ง job msg
        const targetWs2 = clients.get(target);
        if (targetWs2 && targetWs2.readyState === 1) {
          targetWs2.send(JSON.stringify({ type: 'job', id, accountNo, bankName, sentBy: sentBy || 'unknown' }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id, online: !!targetWs }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ===== WebSocket =====
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let name = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'register' && msg.name) {
        name = msg.name;
        clients.set(name, ws);
        console.log(`[WS] registered: ${name} (total: ${clients.size})`);
        ws.send(JSON.stringify({ type: 'registered', name }));

        // ส่ง pending jobs ที่มีอยู่แล้วทันที
        const pending = [...jobs.values()].filter(j => j.target === name && j.status === 'pending');
        pending.forEach(j => {
          ws.send(JSON.stringify({ type: 'job', id: j.id, accountNo: j.accountNo, bankName: j.bankName, sentBy: j.sentBy }));
          ws.send(JSON.stringify({ type: 'search', id: j.id, accountNo: j.accountNo, bankName: j.bankName, sentBy: j.sentBy }));
          j.status = 'sent-ws';
        });
        return;
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    if (name) {
      clients.delete(name);
      console.log(`[WS] disconnected: ${name} (total: ${clients.size})`);
    }
  });

  ws.on('error', () => { if (name) clients.delete(name); });
});

// ===== Cleanup jobs เก่า ทุก 5 นาที =====
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 600000) { jobs.delete(id); }
  }
}, 300000);

server.listen(PORT, () => {
  console.log(`✅ savebank-server running on port ${PORT}`);
});
