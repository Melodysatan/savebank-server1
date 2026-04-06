const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // รองรับ base64 รูป

// ========== In-Memory Store ==========
// queue[targetUser] = [{ id, data, createdAt }, ...]
const queue = {};

function getQueue(user) {
  if (!queue[user]) queue[user] = [];
  return queue[user];
}

// ล้าง item ที่ค้างนานเกิน 5 นาที
setInterval(() => {
  const now = Date.now();
  for (const user in queue) {
    queue[user] = queue[user].filter(item => now - item.createdAt < 5 * 60 * 1000);
  }
}, 60 * 1000);

// ========== Routes ==========

// Health check
app.get('/api/status', (req, res) => {
  const totalUsers = Object.keys(queue).length;
  const totalItems = Object.values(queue).reduce((a, b) => a + b.length, 0);
  res.json({ success: true, users: totalUsers, items: totalItems });
});

// Chrome A → ส่งข้อมูล+รูปมาเก็บ
// Body: { target, username, withdrawName, web, screenshot (base64 optional) }
app.post('/api/push', (req, res) => {
  const { target, username, withdrawName, web, screenshot } = req.body;

  if (!target || !username || !withdrawName || !web) {
    return res.status(400).json({ success: false, error: 'ข้อมูลไม่ครบ' });
  }

  const id = Date.now().toString();
  const item = {
    id,
    username,
    withdrawName,
    web,
    screenshot: screenshot || null,
    createdAt: Date.now()
  };

  getQueue(target).push(item);
  console.log(`[PUSH] target=${target} web=${web} user=${username}`);
  res.json({ success: true, id });
});

// Chrome B → ดึงข้อมูลล่าสุด
// Params: :user = ชื่อผู้รับ
app.get('/api/pull/:user', (req, res) => {
  const user = req.params.user;
  const items = getQueue(user);

  if (items.length === 0) {
    return res.json({ success: true, data: null });
  }

  // ส่งอันแรกสุดก่อน (FIFO)
  const item = items[0];
  res.json({ success: true, data: item });
});

// Chrome B → ยืนยันรับแล้ว ลบออกจาก queue
// Params: :user, :id
app.post('/api/ack/:user/:id', (req, res) => {
  const { user, id } = req.params;
  const before = getQueue(user).length;
  queue[user] = getQueue(user).filter(item => item.id !== id);
  const after = getQueue(user).length;
  console.log(`[ACK] user=${user} id=${id} removed=${before - after}`);
  res.json({ success: true });
});

// ========== Start ==========
app.listen(PORT, () => {
  console.log(`✅ SaveBank Server running on port ${PORT}`);
});
