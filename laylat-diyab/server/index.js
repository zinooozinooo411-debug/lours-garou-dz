const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../client/public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/public/index.html')));

const rooms = {};
const COLORS = ['#c8a84b','#e74c3c','#3498db','#2ecc71','#9b59b6','#e67e22','#1abc9c','#e91e63','#f39c12','#16a085','#8e44ad','#27ae60','#2980b9','#d35400','#c0392b'];

const ROLE_LABELS = { wolf:'🐺 الذيب', silencer:'🔕 ذيب التسكيت', doctor:'👨‍⚕️ الطبيب', detective:'🔍 الشواف', chief:'👴 شيخ القبيلة', blessed:'😇 الولد الصالح', civilian:'🧑 مدني' };

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = 'DZ';
  for (let i = 0; i < 4; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

function sysMsg(code, msg) { io.to(code).emit('chat:system', msg); }

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  room.players.forEach(p => {
    const sk = io.sockets.sockets.get(p.socketId);
    if (!sk) return;
    const isWolf = p.role === 'wolf' || p.role === 'silencer';
    sk.emit('room:update', {
      code: room.code, phase: room.phase, round: room.round,
      speakerId: room.speakerId,
      speakerName: room.players.find(x => x.id === room.speakerId)?.name || '',
      hostId: room.hostId,
      players: room.players.map(pl => ({
        id: pl.id, name: pl.name, color: pl.color,
        eliminated: pl.eliminated, silenced: pl.silenced,
        votes: pl.votes, chiefVotes: pl.chiefVotes, isChief: pl.isChief,
        role: (pl.id === p.id || pl.eliminated ||
          (room.phase === 'night' && isWolf && (pl.role === 'wolf' || pl.role === 'silencer'))
        ) ? pl.role : null
      })),
      myRole: p.role, myId: p.id, myIsChief: p.isChief, hostId: room.hostId
    });
  });
}

function clearRoomTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
}

function startTimer(code, seconds, onEnd) {
  const room = rooms[code];
  if (!room) return;
  clearRoomTimer(room);
  room.timerSec = seconds;
  io.to(code).emit('timer:tick', seconds);
  room.timerInterval = setInterval(() => {
    if (!rooms[code]) { clearInterval(room.timerInterval); return; }
    room.timerSec--;
    io.to(code).emit('timer:tick', room.timerSec);
    if (room.timerSec <= 0) { clearRoomTimer(room); onEnd(); }
  }, 1000);
}

function assignRoles(players, settings) {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const roles = [];
  let wc = Math.max(1, Math.min(settings.wolves, Math.floor(players.length / 3)));
  if (settings.silencer && wc > 0) { roles.push('silencer'); wc--; }
  for (let i = 0; i < wc; i++) roles.push('wolf');
  if (settings.doctor) roles.push('doctor');
  if (settings.detective) roles.push('detective');
  if (settings.blessed) roles.push('blessed');
  while (roles.length < players.length) roles.push('civilian');
  return shuffled.map((p, i) => ({ ...p, role: roles[i], eliminated: false, silenced: false, votes: 0, chiefVotes: 0, isChief: false, nightVote: null, dayVoted: null }));
}

function getActive(room) { return room.players.filter(p => !p.eliminated); }

// ─── CHIEF VOTE ───────────────────────────────────────────────────────
function startChiefVote(code) {
  const room = rooms[code];
  if (!room) return;
  room.phase = 'chief_vote';
  room.chiefVoteMap = {};
  room.players.forEach(p => { p.chiefVotes = 0; });
  io.to(code).emit('phase:change', { phase: 'chief_vote', round: 0 });
  sysMsg(code, '👴 صوّتوا على من يكون شيخ القبيلة!');
  broadcastRoom(code);
  startTimer(code, 45, () => resolveChiefVote(code));
}

function resolveChiefVote(code) {
  const room = rooms[code];
  if (!room) return;
  clearRoomTimer(room);
  let maxV = 0, chief = null, tied = false;
  room.players.forEach(p => {
    if (p.chiefVotes > maxV) { maxV = p.chiefVotes; chief = p; tied = false; }
    else if (p.chiefVotes === maxV && maxV > 0) { tied = true; }
  });
  if (chief && !tied) {
    chief.isChief = true;
    sysMsg(code, `👴 ${chief.name} أصبح شيخ القبيلة — صوته يساوي 3 أصوات!`);
  } else {
    sysMsg(code, '🤝 تعادل الأصوات — لا يوجد شيخ قبيلة');
  }
  broadcastRoom(code);
  setTimeout(() => launchMainGame(code), 2500);
}

// ─── MAIN GAME LAUNCH ────────────────────────────────────────────────
function launchMainGame(code) {
  const room = rooms[code];
  if (!room) return;
  room.phase = 'day';
  room.round = 1;
  room.speakerIdx = 0;
  room.players.forEach(p => { p.votes = 0; p.dayVoted = null; p.nightVote = null; });
  io.to(code).emit('phase:change', { phase: 'day', round: 1 });
  sysMsg(code, '🐺 اللعبة بدأت! كل واحد يتكلم ويدافع عن نفسه');
  broadcastRoom(code);
  startSpeakerTurn(code);
}

// ─── DAY SPEAKING ────────────────────────────────────────────────────
function startSpeakerTurn(code) {
  const room = rooms[code];
  if (!room) return;
  const active = getActive(room);
  if (!active.length) return;

  const idx = room.speakerIdx % active.length;
  const speaker = active[idx];
  room.speakerId = speaker.id;

  if (speaker.silenced) {
    speaker.silenced = false;
    sysMsg(code, `🔕 ${speaker.name} مسكّت — يتخطى دوره`);
    io.to(code).emit('speaker:change', { speakerId: speaker.id, speakerName: speaker.name, silenced: true });
    broadcastRoom(code);
    setTimeout(() => advanceSpeaker(code), 2000);
    return;
  }

  io.to(code).emit('speaker:change', { speakerId: speaker.id, speakerName: speaker.name, silenced: false });
  broadcastRoom(code);
  startTimer(code, 60, () => advanceSpeaker(code));
}

function advanceSpeaker(code) {
  const room = rooms[code];
  if (!room || room.phase !== 'day') return;
  clearRoomTimer(room);
  const active = getActive(room);
  room.speakerIdx++;
  if (room.speakerIdx >= active.length) {
    room.speakerIdx = 0;
    startDayVoting(code);
  } else {
    startSpeakerTurn(code);
  }
}

// ─── DAY VOTING ──────────────────────────────────────────────────────
function startDayVoting(code) {
  const room = rooms[code];
  if (!room) return;
  room.phase = 'day_vote';
  room.players.forEach(p => { p.votes = 0; p.dayVoted = null; });
  io.to(code).emit('phase:change', { phase: 'day_vote', round: room.round });
  sysMsg(code, '🗳️ وقت التصويت! من تظنون أنه الذيب؟ عندكم 60 ثانية');
  broadcastRoom(code);
  startTimer(code, 60, () => resolveDayVote(code));
}

function resolveDayVote(code) {
  const room = rooms[code];
  if (!room) return;
  clearRoomTimer(room);
  const active = getActive(room);
  let maxV = 0, target = null, tied = false;
  active.forEach(p => {
    if (p.votes > maxV) { maxV = p.votes; target = p; tied = false; }
    else if (p.votes === maxV && maxV > 0) { tied = true; }
  });
  if (!target || maxV === 0) {
    sysMsg(code, '😶 ما كانش تصويت — لا أحد يخرج اليوم!');
  } else if (tied) {
    sysMsg(code, '🤝 تعادل الأصوات — لا أحد يخرج اليوم!');
  } else {
    target.eliminated = true;
    sysMsg(code, `🗳️ ${target.name} خرج من اللعبة بأغلبية الأصوات — كان ${ROLE_LABELS[target.role] || 'مدني'}`);
    io.to(code).emit('player:eliminated', { playerId: target.id, playerName: target.name, role: target.role });
    if (target.role === 'blessed') triggerBlessed(code, target);
  }
  if (checkWin(code)) return;
  startNight(code);
}

// ─── NIGHT ───────────────────────────────────────────────────────────
function startNight(code) {
  const room = rooms[code];
  if (!room) return;
  room.phase = 'night';
  room.players.forEach(p => { p.nightVote = null; });
  io.to(code).emit('phase:change', { phase: 'night', round: room.round });
  sysMsg(code, '🌙 جاء الليل! الذياب والشواف والطبيب يتحركون...');
  broadcastRoom(code);
  startTimer(code, 40, () => resolveNight(code));
}

function resolveNight(code) {
  const room = rooms[code];
  if (!room) return;
  clearRoomTimer(room);

  const wolves = room.players.filter(p => !p.eliminated && (p.role === 'wolf' || p.role === 'silencer'));
  const doctor = room.players.find(p => !p.eliminated && p.role === 'doctor');
  const detective = room.players.find(p => !p.eliminated && p.role === 'detective');
  const silencer = room.players.find(p => !p.eliminated && p.role === 'silencer');

  const wolfVotes = {};
  wolves.forEach(p => { if (p.nightVote) wolfVotes[p.nightVote] = (wolfVotes[p.nightVote] || 0) + 1; });
  let wolfTarget = null, maxWV = 0;
  Object.entries(wolfVotes).forEach(([id, v]) => { if (v > maxWV) { maxWV = v; wolfTarget = id; } });

  const doctorSave = doctor?.nightVote || null;

  if (detective?.nightVote) {
    const tgt = room.players.find(p => p.id === detective.nightVote);
    if (tgt) {
      const sk = io.sockets.sockets.get(detective.socketId);
      sk?.emit('detective:result', { targetName: tgt.name, isWolf: tgt.role === 'wolf' || tgt.role === 'silencer' });
    }
  }

  if (silencer?.nightVote && silencer.nightVote !== wolfTarget) {
    const stgt = room.players.find(p => p.id === silencer.nightVote && !p.eliminated);
    if (stgt) stgt.silenced = true;
  }

  if (wolfTarget && wolfTarget !== doctorSave) {
    const victim = room.players.find(p => p.id === wolfTarget && !p.eliminated);
    if (victim) {
      victim.eliminated = true;
      sysMsg(code, `🐺 الذياب هاجموا ${victim.name}! كان ${ROLE_LABELS[victim.role] || 'مدني'}`);
      io.to(code).emit('player:eliminated', { playerId: victim.id, playerName: victim.name, role: victim.role });
      if (victim.role === 'blessed') triggerBlessed(code, victim);
    }
  } else if (wolfTarget && wolfTarget === doctorSave) {
    sysMsg(code, '💊 الطبيب أنقذ شخصاً الليلة!');
  } else {
    sysMsg(code, '🌙 الليلة ما صار شيء...');
  }

  if (checkWin(code)) return;
  startNewDay(code);
}

function startNewDay(code) {
  const room = rooms[code];
  if (!room) return;
  room.round++;
  room.phase = 'day';
  room.speakerIdx = 0;
  room.players.forEach(p => { p.votes = 0; p.dayVoted = null; p.nightVote = null; });
  io.to(code).emit('phase:change', { phase: 'day', round: room.round });
  sysMsg(code, `☀️ صباح الجولة ${room.round} — كل واحد يتكلم!`);
  broadcastRoom(code);
  startSpeakerTurn(code);
}

function triggerBlessed(code, player) {
  const room = rooms[code];
  if (!room) return;
  const sk = io.sockets.sockets.get(player.socketId);
  if (!sk) return;
  const choices = room.players.filter(p => !p.eliminated && p.id !== player.id).map(p => ({ id: p.id, name: p.name }));
  if (choices.length > 0) sk.emit('blessed:choose', { players: choices });
}

function checkWin(code) {
  const room = rooms[code];
  if (!room) return false;
  const alive = room.players.filter(p => !p.eliminated);
  const wolves = alive.filter(p => p.role === 'wolf' || p.role === 'silencer');
  const vils = alive.filter(p => p.role !== 'wolf' && p.role !== 'silencer');
  if (wolves.length === 0) {
    clearRoomTimer(room);
    io.to(code).emit('game:over', { winner: 'village', message: 'فازت القرية! كل الذياب تم كشفهم 🎉', players: room.players });
    delete rooms[code]; return true;
  }
  if (wolves.length >= vils.length) {
    clearRoomTimer(room);
    io.to(code).emit('game:over', { winner: 'wolves', message: 'فاز الذياب! سيطروا على القرية 🐺', players: room.players });
    delete rooms[code]; return true;
  }
  return false;
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('room:create', ({ playerName, settings }) => {
    let code; do { code = genCode(); } while (rooms[code]);
    const player = { id: uuidv4(), socketId: socket.id, name: playerName, color: COLORS[0], isHost: true, role: null, eliminated: false, silenced: false, votes: 0, chiefVotes: 0, isChief: false, nightVote: null, dayVoted: null };
    rooms[code] = { code, hostId: player.id, players: [player], settings: settings || { wolves:2, silencer:true, doctor:true, detective:true, blessed:true, chief:true }, phase: 'lobby', round: 0, speakerIdx: 0, speakerId: null, timerSec: 0, timerInterval: null, chiefVoteMap: {} };
    socket.join(code);
    socket.emit('room:created', { code, playerId: player.id });
    broadcastRoom(code);
  });

  socket.on('room:join', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', { msg: '❌ الغرفة ما موجودتش' }); return; }
    if (room.phase !== 'lobby') { socket.emit('error', { msg: '❌ اللعبة بدأت بالفعل' }); return; }
    if (room.players.length >= 15) { socket.emit('error', { msg: '❌ الغرفة ممتلئة' }); return; }
    if (room.players.find(p => p.name === playerName)) { socket.emit('error', { msg: '❌ الاسم مستخدم' }); return; }
    const player = { id: uuidv4(), socketId: socket.id, name: playerName, color: COLORS[room.players.length % COLORS.length], isHost: false, role: null, eliminated: false, silenced: false, votes: 0, chiefVotes: 0, isChief: false, nightVote: null, dayVoted: null };
    room.players.push(player);
    socket.join(code);
    socket.emit('room:joined', { code, playerId: player.id });
    sysMsg(code, `👤 ${playerName} دخل للغرفة`);
    broadcastRoom(code);
  });

  socket.on('settings:update', ({ code, settings }) => {
    const room = rooms[code];
    if (!room) return;
    const p = room.players.find(x => x.socketId === socket.id);
    if (!p?.isHost) return;
    room.settings = { ...room.settings, ...settings };
    broadcastRoom(code);
  });

  socket.on('game:start', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const p = room.players.find(x => x.socketId === socket.id);
    if (!p?.isHost) return;
    if (room.players.length < 6) { socket.emit('error', { msg: '❌ تحتاج على الأقل 6 لاعبين' }); return; }
    room.players = assignRoles(room.players, room.settings);
    broadcastRoom(code);
    if (room.settings.chief) startChiefVote(code);
    else launchMainGame(code);
  });

  socket.on('chief:vote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'chief_vote') return;
    const voter = room.players.find(p => p.socketId === socket.id);
    if (!voter) return;
    if (room.chiefVoteMap[voter.id]) {
      const prev = room.players.find(p => p.id === room.chiefVoteMap[voter.id]);
      if (prev) prev.chiefVotes = Math.max(0, prev.chiefVotes - 1);
    }
    if (room.chiefVoteMap[voter.id] === targetId) { delete room.chiefVoteMap[voter.id]; }
    else { room.chiefVoteMap[voter.id] = targetId; const t = room.players.find(p => p.id === targetId); if (t) t.chiefVotes++; }
    broadcastRoom(code);
  });

  socket.on('chief:end', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const p = room.players.find(x => x.socketId === socket.id);
    if (!p?.isHost) return;
    clearRoomTimer(room);
    resolveChiefVote(code);
  });

  socket.on('day:vote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day_vote') return;
    const voter = room.players.find(p => p.socketId === socket.id);
    if (!voter || voter.eliminated) return;
    const vw = voter.isChief ? 3 : 1;
    if (voter.dayVoted) { const prev = room.players.find(p => p.id === voter.dayVoted); if (prev) prev.votes = Math.max(0, prev.votes - vw); }
    if (voter.dayVoted === targetId) { voter.dayVoted = null; }
    else { voter.dayVoted = targetId; const t = room.players.find(p => p.id === targetId); if (t) t.votes += vw; }
    broadcastRoom(code);
  });

  socket.on('day:abstain', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day_vote') return;
    const voter = room.players.find(p => p.socketId === socket.id);
    if (!voter || voter.eliminated) return;
    if (voter.dayVoted) {
      const vw = voter.isChief ? 3 : 1;
      const prev = room.players.find(p => p.id === voter.dayVoted);
      if (prev) prev.votes = Math.max(0, prev.votes - vw);
      voter.dayVoted = null;
      broadcastRoom(code);
    }
  });

  socket.on('day:force_resolve', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const p = room.players.find(x => x.socketId === socket.id);
    if (!p?.isHost) return;
    clearRoomTimer(room);
    resolveDayVote(code);
  });

  socket.on('speaker:skip', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;
    const p = room.players.find(x => x.socketId === socket.id);
    if (!p) return;
    if (p.id !== room.speakerId && !p.isHost) return;
    advanceSpeaker(code);
  });

  socket.on('night:vote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'night') return;
    const voter = room.players.find(p => p.socketId === socket.id);
    if (!voter || voter.eliminated) return;
    voter.nightVote = targetId;
    socket.emit('night:ack', { targetId });
  });

  socket.on('blessed:choice', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room) return;
    const tgt = room.players.find(p => p.id === targetId && !p.eliminated);
    if (tgt) {
      tgt.eliminated = true;
      sysMsg(code, `😇 الولد الصالح اختار ${tgt.name} يخرج معه`);
      io.to(code).emit('player:eliminated', { playerId: tgt.id, playerName: tgt.name, role: tgt.role });
      checkWin(code);
      broadcastRoom(code);
    }
  });

  socket.on('chat:message', ({ code, text }) => {
    const room = rooms[code];
    if (!room) return;
    const p = room.players.find(x => x.socketId === socket.id);
    if (!p || p.eliminated) return;
    const clean = (text || '').trim().substring(0, 200);
    if (!clean) return;
    io.to(code).emit('chat:message', { author: p.name, text: clean, color: p.color });
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(code => {
      const room = rooms[code];
      if (!room) return;
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx === -1) return;
      const p = room.players[idx];
      if (room.phase === 'lobby') {
        room.players.splice(idx, 1);
        if (!room.players.length) { delete rooms[code]; return; }
        if (p.isHost) { room.players[0].isHost = true; room.hostId = room.players[0].id; sysMsg(code, `👑 ${room.players[0].name} أصبح المضيف`); }
        broadcastRoom(code);
      } else {
        p.eliminated = true;
        sysMsg(code, `👤 ${p.name} غادر اللعبة`);
        if (p.id === room.speakerId && room.phase === 'day') advanceSpeaker(code);
        checkWin(code);
        broadcastRoom(code);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🐺 ليلة الذياب على البورت ${PORT}`));
