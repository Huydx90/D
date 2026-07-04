const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', true); // chạy sau reverse proxy (Render.com...), cần để Express hiểu header X-Forwarded-For
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000; // Render tự cấp PORT qua biến môi trường, không cố định 3000
const MAX_LOG_ENTRIES = 1000;   // chỉ giữ lại 1000 dòng nhật ký gần nhất
const MAX_CHAT_MESSAGES = 5000; // chỉ giữ lại 5000 dòng chat gần nhất

// ===== Kết nối PostgreSQL =====
// CHỈ đọc từ biến môi trường DATABASE_URL (đặt trong tab Environment của Render) — không hard-code
// chuỗi kết nối/mật khẩu trong code để tránh lộ khi đẩy lên GitHub hay chia sẻ file.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    console.error('❌ Thiếu biến môi trường DATABASE_URL. Vào Render → Web Service → Environment để thêm.');
    process.exit(1);
}
// Internal Database URL (dạng "...@dpg-xxxx-a/dbname", không có ".render.com") chạy nội bộ trong
// cùng region, không cần SSL. External Database URL (có "...render.com") bắt buộc phải bật SSL.
const isExternalUrl = /\.render\.com/.test(connectionString);
const pool = new Pool({
    connectionString,
    ssl: isExternalUrl ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
    // Lỗi trên 1 connection đang rảnh trong pool - log lại thay vì để crash cả server
    console.error('Lỗi không mong đợi từ PostgreSQL pool:', err);
});

// Tạo bảng nếu chưa có (chạy 1 lần khi server khởi động)
async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS lineup_data (
            id INT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS lineup_logs (
            id SERIAL PRIMARY KEY,
            time TIMESTAMPTZ NOT NULL,
            ip TEXT,
            action TEXT
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id SERIAL PRIMARY KEY,
            msg_id TEXT,
            time TIMESTAMPTZ NOT NULL,
            ip TEXT,
            name TEXT,
            text TEXT
        )
    `);
    console.log('✅ Đã kết nối PostgreSQL và kiểm tra xong cấu trúc bảng.');
}

// Serve static files
app.use(express.static(__dirname));

// Default lineup data - chỉ dùng khi bảng lineup_data trong DB đang trống (lần chạy đầu tiên)
const defaultData = {
    players: {
        'gk': { name: 'Tân Long', position: 'Thủ môn' },
        'def1': { name: 'Phúc Lâm', position: 'Hậu vệ' },
        'def2': { name: 'Chung', position: 'Hậu vệ' },
        'mid1': { name: 'Sếp Hải', position: 'Tiền vệ' },
        'mid2': { name: 'Chứ', position: 'Tiền vệ' },
        'mid3': { name: 'Dũng', position: 'Tiền vệ' },
        'fwd': { name: 'A Sĩ', position: 'Tiền đạo' }
    },
    substitutes: ['Toàn', 'Chính', 'Hoàng', 'Khánh', 'Sơn', 'Hùng', 'Hiếu', 'Dương', 'Mỹ Linh', 'Khiêm', 'Lộc'],
    playerStats: {
        'Tân Long': { health: 85, skill: 70, stamina: 80, speed: 65, position: 'Thủ môn' },
        'Phúc Lâm': { health: 80, skill: 75, stamina: 85, speed: 70, position: 'Hậu vệ' },
        'Chung': { health: 82, skill: 73, stamina: 83, speed: 68, position: 'Hậu vệ' },
        'Sếp Hải': { health: 78, skill: 85, stamina: 80, speed: 75, position: 'Tiền vệ' },
        'Chứ': { health: 75, skill: 78, stamina: 82, speed: 80, position: 'Tiền vệ' },
        'Dũng': { health: 80, skill: 82, stamina: 78, speed: 77, position: 'Tiền vệ' },
        'A Sĩ': { health: 77, skill: 88, stamina: 75, speed: 85, position: 'Tiền đạo' },
        'Toàn': { health: 75, skill: 70, stamina: 80, speed: 72, position: 'Dự bị' },
        'Chính': { health: 78, skill: 72, stamina: 75, speed: 70, position: 'Dự bị' },
        'Hoàng': { health: 80, skill: 68, stamina: 82, speed: 65, position: 'Dự bị' },
        'Khánh': { health: 72, skill: 75, stamina: 78, speed: 80, position: 'Dự bị' },
        'Sơn': { health: 85, skill: 65, stamina: 70, speed: 68, position: 'Dự bị' },
        'Hùng': { health: 78, skill: 80, stamina: 75, speed: 73, position: 'Dự bị' },
        'Hiếu': { health: 70, skill: 72, stamina: 85, speed: 75, position: 'Dự bị' },
        'Dương': { health: 76, skill: 74, stamina: 80, speed: 78, position: 'Dự bị' },
        'Mỹ Linh': { health: 73, skill: 82, stamina: 77, speed: 82, position: 'Dự bị' },
        'Khiêm': { health: 80, skill: 70, stamina: 83, speed: 68, position: 'Dự bị' },
        'Lộc': { health: 77, skill: 76, stamina: 79, speed: 74, position: 'Dự bị' }
    }
};

// ===== Đội hình: lưu 1 dòng duy nhất (id = 1) trong bảng lineup_data =====
async function loadData() {
    try {
        const res = await pool.query('SELECT data FROM lineup_data WHERE id = 1');
        if (res.rows.length > 0) return res.rows[0].data;
    } catch (err) {
        console.error('Lỗi đọc lineup_data:', err);
    }
    return defaultData;
}

async function saveData(data) {
    try {
        await pool.query(
            `INSERT INTO lineup_data (id, data, updated_at) VALUES (1, $1, now())
             ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
            [JSON.stringify(data)]
        );
        return true;
    } catch (err) {
        console.error('Lỗi ghi lineup_data:', err);
        return false;
    }
}

// ===== Nhật ký chỉnh sửa (edit log) - mới nhất trước, tối đa MAX_LOG_ENTRIES dòng =====
async function loadLog() {
    try {
        const res = await pool.query(
            'SELECT time, ip, action FROM lineup_logs ORDER BY id DESC LIMIT $1',
            [MAX_LOG_ENTRIES]
        );
        return res.rows.map(r => ({ time: r.time.toISOString(), ip: r.ip, action: r.action }));
    } catch (err) {
        console.error('Lỗi đọc lineup_logs:', err);
        return [];
    }
}

async function appendLog(entry) {
    try {
        await pool.query(
            'INSERT INTO lineup_logs (time, ip, action) VALUES ($1, $2, $3)',
            [entry.time, entry.ip, entry.action]
        );
        // Xoá bớt các dòng cũ vượt quá giới hạn để bảng không phình to vô hạn
        await pool.query(
            'DELETE FROM lineup_logs WHERE id NOT IN (SELECT id FROM lineup_logs ORDER BY id DESC LIMIT $1)',
            [MAX_LOG_ENTRIES]
        );
    } catch (err) {
        console.error('Lỗi ghi lineup_logs:', err);
    }
}

// ===== Chat nội bộ - lưu theo thứ tự thời gian tăng dần, tối đa MAX_CHAT_MESSAGES dòng =====
async function loadChat() {
    try {
        const res = await pool.query(`
            SELECT msg_id AS id, time, ip, name, text
            FROM (SELECT * FROM chat_messages ORDER BY id DESC LIMIT $1) recent
            ORDER BY id ASC
        `, [MAX_CHAT_MESSAGES]);
        return res.rows.map(r => ({ id: r.id, time: r.time.toISOString(), ip: r.ip, name: r.name, text: r.text }));
    } catch (err) {
        console.error('Lỗi đọc chat_messages:', err);
        return [];
    }
}

async function appendChatMessage(entry) {
    try {
        await pool.query(
            'INSERT INTO chat_messages (msg_id, time, ip, name, text) VALUES ($1, $2, $3, $4, $5)',
            [entry.id, entry.time, entry.ip, entry.name, entry.text]
        );
        await pool.query(
            'DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT $1)',
            [MAX_CHAT_MESSAGES]
        );
    } catch (err) {
        console.error('Lỗi ghi chat_messages:', err);
    }
}

// Gom vị trí hiện tại của từng cầu thủ (trên sân hay dự bị) để so sánh trước/sau
function locationsOf(data) {
    const loc = {};
    if (data && data.players) {
        for (const info of Object.values(data.players)) {
            if (info && info.name) loc[info.name] = { type: 'field', position: info.position };
        }
    }
    if (data && Array.isArray(data.substitutes)) {
        data.substitutes.forEach(name => { loc[name] = { type: 'bench' }; });
    }
    return loc;
}

// Tự sinh mô tả thay đổi (tiếng Việt) bằng cách so sánh dữ liệu cũ và mới
function describeChanges(oldData, newData) {
    const changes = [];
    const oldLoc = locationsOf(oldData);
    const newLoc = locationsOf(newData);
    const names = new Set([...Object.keys(oldLoc), ...Object.keys(newLoc)]);

    names.forEach(name => {
        const o = oldLoc[name], n = newLoc[name];
        if (!o || !n) return;
        if (o.type === 'bench' && n.type === 'field') {
            changes.push(name + ' vào sân (' + n.position + ')');
        } else if (o.type === 'field' && n.type === 'bench') {
            changes.push(name + ' xuống dự bị');
        } else if (o.type === 'field' && n.type === 'field' && o.position !== n.position) {
            changes.push(name + ': ' + o.position + ' → ' + n.position);
        }
    });

    const oldStats = (oldData && oldData.playerStats) || {};
    const newStats = (newData && newData.playerStats) || {};
    Object.keys(newStats).forEach(name => {
        const o = oldStats[name], n = newStats[name];
        if (!o || !n) return;
        if (o.health !== n.health || o.skill !== n.skill || o.stamina !== n.stamina || o.speed !== n.speed) {
            changes.push('Cập nhật chỉ số: ' + name);
        }
    });

    if (changes.length === 0) return 'Cập nhật đội hình';
    if (changes.length > 4) {
        return changes.slice(0, 3).join('; ') + '; và ' + (changes.length - 3) + ' thay đổi khác';
    }
    return changes.join('; ');
}

// ===== API endpoints (chuyển sang async/await vì giờ đọc/ghi PostgreSQL) =====
app.get('/api/data', async (req, res) => {
    res.json(await loadData());
});

app.get('/api/log', async (req, res) => {
    res.json({ log: await loadLog() });
});

app.get('/api/chat', async (req, res) => {
    res.json({ messages: await loadChat() });
});

app.post('/api/data', express.json(), async (req, res) => {
    const requesterClientId = req.body && req.body.clientId;
    const actionLabel = req.body && req.body.actionLabel; // nhãn nhật ký tuỳ chọn (vd: khôi phục từ file JSON)

    // Reject saves from a client that doesn't currently hold the edit lock
    if (editLock && editLock.clientId !== requesterClientId) {
        return res.status(423).json({
            success: false,
            error: 'locked',
            lockedByIp: editLock.ip
        });
    }

    const oldData = await loadData(); // lấy trạng thái trước khi ghi đè, để so sánh sinh nhật ký
    const newData = { ...req.body };
    delete newData.clientId; // don't persist this into the DB row
    delete newData.actionLabel;

    if (await saveData(newData)) {
        const ip = getClientIp(req);
        const entry = { time: new Date().toISOString(), ip, action: actionLabel || describeChanges(oldData, newData) };
        await appendLog(entry);

        // Broadcast to all connected clients
        broadcast(JSON.stringify({ type: 'update', data: newData }));
        broadcast(JSON.stringify({ type: 'log_entry', entry }));
        res.json({ success: true, data: newData });
    } else {
        res.status(500).json({ success: false, error: 'Failed to save data' });
    }
});

// WebSocket handling
const clients = new Set();

// ===== Edit lock: only one client may edit at a time =====
// editLock = { clientId, ip } | null
let editLock = null;
let lockSafetyTimer = null;
const LOCK_SAFETY_TIMEOUT_MS = 20000; // auto-release if a client forgets to unlock

function getClientIp(req) {
    // Khi chạy sau reverse proxy (Render.com, Railway, Nginx...), req.socket.remoteAddress
    // chỉ là địa chỉ nội bộ của proxy (thường ra 127.0.0.1) — IP thật của client nằm ở
    // header X-Forwarded-For do proxy gắn vào, dạng "client, proxy1, proxy2,...".
    const xff = req.headers && req.headers['x-forwarded-for'];
    let ip = (xff ? xff.split(',')[0].trim() : null) || req.socket.remoteAddress || 'unknown';
    if (ip.startsWith('::ffff:')) ip = ip.substring(7); // normalize IPv4-mapped IPv6
    if (ip === '::1') ip = '127.0.0.1';
    return ip;
}

function armLockSafetyTimer() {
    clearTimeout(lockSafetyTimer);
    lockSafetyTimer = setTimeout(() => {
        console.log('Lock safety timeout - tự động nhả khóa cho', editLock && editLock.ip);
        releaseLock();
    }, LOCK_SAFETY_TIMEOUT_MS);
}

function releaseLock() {
    if (!editLock) return;
    editLock = null;
    clearTimeout(lockSafetyTimer);
    broadcast(JSON.stringify({ type: 'lock_status', locked: false }));
}

let nextClientId = 1;

wss.on('connection', async (ws, req) => {
    ws.clientId = 'c' + (nextClientId++);
    ws.ip = getClientIp(req);
    console.log('New client connected:', ws.clientId, ws.ip);
    clients.add(ws);
    broadcastOnlineList();

    // Tell this client who it is
    ws.send(JSON.stringify({ type: 'welcome', clientId: ws.clientId, ip: ws.ip }));

    // Send current data to new client (đọc từ PostgreSQL)
    try {
        const data = await loadData();
        ws.send(JSON.stringify({ type: 'init', data: data }));
        ws.send(JSON.stringify({ type: 'log_init', log: await loadLog() }));
        ws.send(JSON.stringify({ type: 'chat_init', messages: await loadChat() }));
    } catch (err) {
        console.error('Lỗi gửi dữ liệu ban đầu cho client:', err);
    }

    // Let the new client know if editing is currently locked by someone
    if (editLock) {
        ws.send(JSON.stringify({ type: 'lock_status', locked: true, clientId: editLock.clientId, ip: editLock.ip }));
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'update') {
                // Only accept edits from whoever currently holds the lock (or if unlocked)
                if (editLock && editLock.clientId !== ws.clientId) {
                    return; // ignore edits from a client that doesn't hold the lock
                }
                await saveData(data.data);
                broadcast(message);
            } else if (data.type === 'lock_request') {
                if (!editLock || editLock.clientId === ws.clientId) {
                    editLock = { clientId: ws.clientId, ip: ws.ip };
                    armLockSafetyTimer();
                    broadcast(JSON.stringify({ type: 'lock_status', locked: true, clientId: ws.clientId, ip: ws.ip }));
                } else {
                    // Someone else is already editing - tell only this client
                    ws.send(JSON.stringify({ type: 'lock_denied', ip: editLock.ip }));
                }
            } else if (data.type === 'lock_release') {
                if (editLock && editLock.clientId === ws.clientId) {
                    releaseLock();
                }
            } else if (data.type === 'chat_message') {
                // Bắt buộc phải có tên mới được gửi chat (server tự kiểm tra lại, không chỉ tin client)
                const name = (data.name || '').toString().trim().slice(0, 40);
                const text = (data.text || '').toString().trim().slice(0, 1000);
                if (!name || !text) return;
                const entry = {
                    id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    time: new Date().toISOString(),
                    ip: ws.ip,
                    name,
                    text
                };
                await appendChatMessage(entry);
                broadcast(JSON.stringify({ type: 'chat_message', entry }));
            } else if (data.type === 'export_log') {
                // Chỉ ghi nhật ký "ai vừa xuất file", không có dữ liệu nào bị thay đổi
                const entry = { time: new Date().toISOString(), ip: ws.ip, action: '📤 Đã xuất dữ liệu cầu thủ ra file JSON' };
                await appendLog(entry);
                broadcast(JSON.stringify({ type: 'log_entry', entry }));
            }
        } catch (err) {
            console.error('Error processing message:', err);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected:', ws.clientId);
        clients.delete(ws);
        broadcastOnlineList();
        if (editLock && editLock.clientId === ws.clientId) {
            releaseLock();
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        clients.delete(ws);
        broadcastOnlineList();
        if (editLock && editLock.clientId === ws.clientId) {
            releaseLock();
        }
    });
});

function broadcast(message) {
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function getOnlineList() {
    // Gộp theo IP để không đếm trùng nếu 1 người mở nhiều tab/thiết bị cùng IP nhiều lần
    const seen = new Map();
    clients.forEach((c) => {
        if (!seen.has(c.ip)) seen.set(c.ip, { ip: c.ip, count: 0 });
        seen.get(c.ip).count++;
    });
    return Array.from(seen.values());
}

function broadcastOnlineList() {
    broadcast(JSON.stringify({ type: 'online_list', clients: getOnlineList() }));
}

// Khởi tạo bảng trong PostgreSQL rồi mới bắt đầu lắng nghe kết nối
initDatabase()
    .then(() => {
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`
╔═══════════════════════════════════════════════════════════╗
║   🏆  ĐỘI HÌNH BÓNG ĐÁ SERVER ĐÃ KHỞI ĐỘNG  🏆           ║
║   📡 Đang lắng nghe ở port ${PORT}
║   💾 Dữ liệu lưu trên PostgreSQL (Render)
║   Nhấn Ctrl+C để dừng server
╚═══════════════════════════════════════════════════════════╝
            `);
        });
    })
    .catch((err) => {
        console.error('❌ Không khởi tạo được database, dừng server:', err);
        process.exit(1);
    });

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nĐang tắt server...');
    wss.clients.forEach((client) => {
        client.close();
    });
    server.close(() => {
        pool.end(() => {
            console.log('Server và kết nối PostgreSQL đã tắt.');
            process.exit(0);
        });
    });
});
