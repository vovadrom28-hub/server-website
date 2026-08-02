const http = require('http');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const net = require('net');

const PORT = 3000;
const MINECRAFT_IP = "217.65.3.28"; 
const MINECRAFT_PORT = 25735;

const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, nickname TEXT, text TEXT, time TEXT, readBy TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS economy (nickname TEXT PRIMARY KEY, coins INTEGER DEFAULT 0, last_bonus TEXT, upgrade_level INTEGER DEFAULT 1)`);
});

let crashState = {
    status: 'waiting', 
    timer: 10.0,         
    multiplier: 1.00,
    crashPoint: 0,
    history: [1.25, 4.50, 1.02, 2.10, 8.40],
    winHistory: []
};

let activeBets = [];

function startCrashCycle() {
    crashState.status = 'waiting';
    crashState.timer = 10.0;
    crashState.multiplier = 1.00;

    let waitInterval = setInterval(() => {
        crashState.timer = parseFloat((crashState.timer - 0.05).toFixed(2));
        if (crashState.timer <= 0) {
            clearInterval(waitInterval);
            crashState.status = 'flying';
            let rand = Math.random();
            crashState.crashPoint = rand < 0.04 ? 1.00 : parseFloat((1 + Math.pow(Math.random(), 2.5) * 12).toFixed(2));
            
            let flyInterval = setInterval(() => {
                let speedFactor = 0.003 * Math.sqrt(crashState.multiplier);
                crashState.multiplier = parseFloat((crashState.multiplier + speedFactor).toFixed(2));
                
                if (crashState.multiplier >= crashState.crashPoint) {
                    clearInterval(flyInterval);
                    crashState.status = 'crashed';
                    crashState.history.unshift(crashState.multiplier);
                    if (crashState.history.length > 8) crashState.history.pop();
                    activeBets = [];
                    setTimeout(startCrashCycle, 4000);
                }
            }, 50);
        }
    }, 50);
}
startCrashCycle();

function pingMinecraftServer(ip, port) {
    return new Promise((resolve) => {
        const client = net.createConnection({ host: ip, port: port }, () => {
            const handshake = Buffer.from([0x00, 0x04, ip.length, ...Buffer.from(ip), (port >> 8) & 0xFF, port & 0xFF, 0x01]);
            const request = Buffer.from([0x00]);
            client.write(Buffer.concat([Buffer.from([handshake.length]), handshake]));
            client.write(Buffer.concat([Buffer.from([request.length]), request]));
        });
        let responseData = Buffer.alloc(0);
        client.on('data', (data) => {
            responseData = Buffer.concat([responseData, data]);
            if (responseData.length > 5) {
                try {
                    const str = responseData.toString('utf-8');
                    const jsonStart = str.indexOf('{');
                    if (jsonStart !== -1) {
                        const jsonStr = str.substring(jsonStart);
                        const cleanJson = jsonStr.substring(0, jsonStr.lastIndexOf('}') + 1);
                        const serverInfo = JSON.parse(cleanJson);
                        resolve({ online: true, now: serverInfo.players.online, max: serverInfo.players.max });
                        client.destroy();
                    }
                } catch (e) {}
            }
        });
        client.on('error', () => resolve({ online: false }));
        client.setTimeout(1500, () => { resolve({ online: false }); client.destroy(); });
    });
}

http.createServer(async (req, res) => {
    let urlPath = decodeURIComponent(req.url);

    if (urlPath === '/api/online') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const status = await pingMinecraftServer(MINECRAFT_IP, MINECRAFT_PORT);
        return res.end(JSON.stringify(status));
    }

    if (urlPath === '/api/crash/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(crashState));
    }

    if (urlPath.startsWith('/api/user/profile')) {
        let name = new URL(req.url, `http://${req.headers.host}`).searchParams.get('nickname') || '';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        db.get("SELECT coins, upgrade_level FROM economy WHERE nickname = ?", [name], (err, row) => {
            let coins = row ? row.coins : 0;
            let level = row ? row.upgrade_level : 1;
            res.end(JSON.stringify({ coins, level }));
        });
        return;
    }

    if (urlPath === '/api/user/bonus' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let data = JSON.parse(body);
            let today = new Date().toDateString();
            db.get("SELECT last_bonus, coins FROM economy WHERE nickname = ?", [data.nickname], (err, row) => {
                if (row && row.last_bonus === today) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Бонус уже получен сегодня!' }));
                }
                let newCoins = (row ? row.coins : 0) + 50;
                db.run("INSERT INTO economy (nickname, coins, last_bonus) VALUES (?, 50, ?) ON CONFLICT(nickname) DO UPDATE SET coins = ?, last_bonus = ?", 
                    [data.nickname, today, newCoins, today], () => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, coins: newCoins, message: 'Вам начислено 50 MineCoins!' }));
                    });
            });
        });
        return;
    }

    if (urlPath === '/api/shop/upgrade' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let data = JSON.parse(body);
            db.get("SELECT coins, upgrade_level FROM economy WHERE nickname = ?", [data.nickname], (err, row) => {
                let currentLvl = row ? row.upgrade_level : 1;
                let currentCoins = row ? row.coins : 0;
                if (currentLvl >= 10) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Максимальный уровень!' }));
                }
                let cost = currentLvl * 150;
                if (currentCoins < cost) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: `Необходимо ${cost} коинов!` }));
                }
                db.run("UPDATE economy SET coins = ?, upgrade_level = ? WHERE nickname = ?", [currentCoins - cost, currentLvl + 1, data.nickname], () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: `Уровень повышен до ${currentLvl + 1}!` }));
                });
            });
        });
        return;
    }

    if (urlPath === '/api/shop/exchange' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let data = JSON.parse(body);
            db.get("SELECT coins, upgrade_level FROM economy WHERE nickname = ?", [data.nickname], (err, row) => {
                let lvl = row ? row.upgrade_level : 1;
                let coins = row ? row.coins : 0;
                let coinCost = 50 + 15 * (lvl - 1);
                let gameCoinsReward = 20;
                if (lvl === 2) gameCoinsReward += 10;
                if (lvl === 3) gameCoinsReward += 50;
                if (lvl === 4) gameCoinsReward += 100;
                if (lvl >= 5) gameCoinsReward += 500;

                if (coins < coinCost) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Недостаточно MineCoins!' }));
                }
                db.run("UPDATE economy SET coins = ? WHERE nickname = ?", [coins - coinCost, data.nickname], () => {
                    console.log(`[СЕРВЕР] /eco give ${data.nickname} ${gameCoinsReward}`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: `Обмен завершен! Отправлено ${gameCoinsReward} монет в игре.` }));
                });
            });
        });
        return;
    }

    if (urlPath === '/api/crash/bet' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let data = JSON.parse(body);
            if (crashState.status !== 'waiting') return res.end(JSON.stringify({ success: false, message: 'Идёт полёт!' }));
            db.get("SELECT coins FROM economy WHERE nickname = ?", [data.nickname], (err, row) => {
                if (!row || row.coins < data.amount || data.amount <= 0) return res.end(JSON.stringify({ success: false, message: 'Нет коинов!' }));
                db.run("UPDATE economy SET coins = ? WHERE nickname = ?", [row.coins - data.amount, data.nickname], () => {
                    activeBets.push({ nickname: data.nickname, amount: data.amount });
                    res.end(JSON.stringify({ success: true }));
                });
            });
        }); return;
    }

    if (urlPath === '/api/crash/cashout' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let data = JSON.parse(body);
        let idx = activeBets.findIndex(b => b.nickname === data.nickname);
        if (idx === -1 || crashState.status !== 'flying') return res.end(JSON.stringify({ success: false }));
        let bet = activeBets[idx]; activeBets.splice(idx, 1);
        let win = Math.floor(bet.amount * crashState.multiplier);
        db.get("SELECT coins FROM economy WHERE nickname = ?", [data.nickname], (err, row) => {
            db.run("UPDATE economy SET coins = ? WHERE nickname = ?", [(row?row.coins:0)+win, data.nickname], () => {
                crashState.winHistory.unshift({ nickname: data.nickname, win, x: crashState.multiplier });
                if(crashState.winHistory.length > 5) crashState.winHistory.pop();
                res.end(JSON.stringify({ success: true, win }));
            });
        });
    }); return;
}

if (urlPath === '/api/chat/messages' && req.method === 'GET') {
    db.all("SELECT * FROM messages ORDER BY id ASC", [], (err, rows) => {
        const formatted = rows.map(row => ({ ...row, readBy: JSON.parse(row.readBy || '[]') }));
        res.end(JSON.stringify(formatted));
    }); return;
}

if (urlPath === '/api/chat/send' && req.method === 'POST') {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
        const msgData = JSON.parse(body);
        const newMessage = { id: Date.now()+""+Math.random(), nickname: msgData.nickname, text: msgData.text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), readBy: JSON.stringify([msgData.nickname]) };
        db.run("INSERT INTO messages (id, nickname, text, time, readBy) VALUES (?, ?, ?, ?, ?)", [newMessage.id, newMessage.nickname, newMessage.text, newMessage.time, newMessage.readBy], () => { res.end(JSON.stringify({ success: true })); });
    }); return;
}

if (urlPath === '/api/chat/read' && req.method === 'POST') {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
        const data = JSON.parse(body);
        db.all("SELECT id, readBy FROM messages", [], (err, rows) => {
            rows.forEach(row => {
                let list = JSON.parse(row.readBy || '[]');
                if (!list.includes(data.nickname)) { list.push(data.nickname); db.run("UPDATE messages SET readBy = ? WHERE id = ?", [JSON.stringify(list), row.id]); }
            });
            res.writeHead(200); res.end();
        });
    }); return;
}

let filePath = './public' + urlPath;
if (urlPath === '/') {
    const userAgent = req.headers['user-agent'] || '';
    filePath = /Android|iPhone|iPad/i.test(userAgent) ? './public/mobile.html' : './public/index.html';
}

const extname = path.extname(filePath);
let contentType = 'text/html';
if (extname === '.css') contentType = 'text/css';
if (extname === '.js') contentType = 'text/javascript';

fs.readFile(filePath, (error, content) => {
    if (error) { res.writeHead(404); res.end('404'); }
    else { res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' }); res.end(content, 'utf-8'); }
});
}).listen(PORT, () => {
    console.log(`Сервер запущен! Перейдите: http://localhost:${PORT}`);
});
