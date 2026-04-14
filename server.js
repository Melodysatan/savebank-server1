// ===== savebank-server1 — server.js =====
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// clients: name → ws
const clients = new Map();

// HTTP server (Render ต้องการ HTTP ด้วย)
const httpServer = http.createServer((req, res) => {
  // Health check / wake-up endpoint
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', clients: clients.size }));
});

// WebSocket server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  let clientName = null;
  console.log('[WS] New connection from', req.socket.remoteAddress);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'register') {
        clientName = msg.name;
        clients.set(clientName, ws);
        console.log(`[WS] Registered: ${clientName} (total: ${clients.size})`);
        ws.send(JSON.stringify({ type: 'registered', name: clientName }));
        return;
      }

      // ส่งข้อมูลค้นหาไปยัง KBiz user
      // format: { type: 'search', to: 'CAPA1', accountNo: '...', bankName: '...', sentBy: '...' }
      if (msg.type === 'search') {
        const target = clients.get(msg.to);
        if (target && target.readyState === 1) {
          target.send(JSON.stringify({
            type: 'search',
            accountNo: msg.accountNo,
            bankName:  msg.bankName,
            sentBy:    msg.sentBy || clientName
          }));
          ws.send(JSON.stringify({ type: 'sent', to: msg.to, ok: true }));
          console.log(`[WS] search: ${msg.accountNo} → ${msg.to}`);
        } else {
          ws.send(JSON.stringify({ type: 'sent', to: msg.to, ok: false, reason: 'target offline' }));
          console.log(`[WS] target offline: ${msg.to}`);
        }
        return;
      }

      // broadcast ไปทุกคน (ถ้าต้องการ)
      if (msg.type === 'broadcast') {
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify({
              type: 'search',
              accountNo: msg.accountNo,
              bankName:  msg.bankName,
              sentBy:    clientName
            }));
          }
        });
        return;
      }

    } catch(e) {
      console.error('[WS] Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    if (clientName) {
      clients.delete(clientName);
      console.log(`[WS] Disconnected: ${clientName} (total: ${clients.size})`);
    }
  });

  ws.on('error', (e) => console.error('[WS] Error:', e.message));
});

httpServer.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
