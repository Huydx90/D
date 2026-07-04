const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', true); // chạy sau reverse proxy (Render.com...), cần để Express hiểu header X-Forwarded-For
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'lineup-data.json');
const LOG_FILE = path.join(__dirname, 'lineup-log.json');
const MAX_LOG_ENTRIES = 1000; // chỉ giữ lại 1000 dòng nhật ký gần nhất

// Serve static files
app.use(express.static(__dirname));

// Default lineup data
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

// Load data from file or use default
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('Error loading data:', err);
    }
    return defaultData;
}

// Save data to file
function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (err) {
        console.error('Error saving data:', err);
        return false;
    }
}

// ===== Nhật ký chỉnh sửa (edit log) =====
function loadLog() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Error loading log:', err);
    }
    return [];
}

function appendLog(entry) {
    const log = loadLog();
    log.unshift(entry); // mới nhất lên đầu
    if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
    try {
        fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
    } catch (err) {
        console.error('Error saving log:', err);
    }
    return log;
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

// API endpoints
app.get('/api/data', (req, res) => {
    const data = loadData();
    res.json(data);
});

app.get('/api/log', (req, res) => {
    res.json({ log: loadLog() });
});

app.post('/api/data', express.json(), (req, res) => {
    const requesterClientId = req.body && req.body.clientId;

    // Reject saves from a client that doesn't currently hold the edit lock
    if (editLock && editLock.clientId !== requesterClientId) {
        return res.status(423).json({
            success: false,
            error: 'locked',
            lockedByIp: editLock.ip
        });
    }

    const oldData = loadData(); // lấy trạng thái trước khi ghi đè, để so sánh sinh nhật ký
    const newData = { ...req.body };
    delete newData.clientId; // don't persist this into the lineup file

    if (saveData(newData)) {
        const ip = getClientIp(req);
        const entry = { time: new Date().toISOString(), ip, action: describeChanges(oldData, newData) };
        appendLog(entry);

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

wss.on('connection', (ws, req) => {
    ws.clientId = 'c' + (nextClientId++);
    ws.ip = getClientIp(req);
    console.log('New client connected:', ws.clientId, ws.ip);
    clients.add(ws);
    broadcastOnlineList();

    // Tell this client who it is
    ws.send(JSON.stringify({ type: 'welcome', clientId: ws.clientId, ip: ws.ip }));

    // Send current data to new client
    const data = loadData();
    ws.send(JSON.stringify({ type: 'init', data: data }));
    ws.send(JSON.stringify({ type: 'log_init', log: loadLog() }));

    // Let the new client know if editing is currently locked by someone
    if (editLock) {
        ws.send(JSON.stringify({ type: 'lock_status', locked: true, clientId: editLock.clientId, ip: editLock.ip }));
    }

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'update') {
                // Only accept edits from whoever currently holds the lock (or if unlocked)
                if (editLock && editLock.clientId !== ws.clientId) {
                    return; // ignore edits from a client that doesn't hold the lock
                }
                saveData(data.data);
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

function getLanIps() {
    const nets = require('os').networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                ips.push(net.address);
            }
        }
    }
    return ips;
}

server.listen(PORT, '0.0.0.0', () => {
    const lanIps = getLanIps();
    const lanLines = lanIps.length
        ? lanIps.map(ip => `║   📡 LAN:     http://${ip}:${PORT}`).join('\n')
        : '║   (Không tìm thấy IP mạng LAN - kiểm tra kết nối mạng)';
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🏆  ĐỘI HÌNH BÓNG ĐÁ SERVER ĐÃ KHỞI ĐỘNG  🏆           ║
║                                                           ║
║   📡 Máy này: http://localhost:${PORT}
${lanLines}
║   💾 Data file: ${DATA_FILE}
║                                                           ║
║   👉 Các máy khác trong CÙNG mạng LAN/WiFi truy cập      ║
║      bằng địa chỉ LAN ở trên để cùng chỉnh đội hình.     ║
║                                                           ║
║   Nhấn Ctrl+C để dừng server                             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nĐang tắt server...');
    wss.clients.forEach((client) => {
        client.close();
    });
    server.close(() => {
        console.log('Server đã tắt.');
        process.exit(0);
    });
});
