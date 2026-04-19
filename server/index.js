const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, '../client/public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/public/index.html')));

// ─── Game State Store ───────────────────────────────────────────────
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'DZ';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function assignRoles(players, settings) {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const roles = [];

  // wolves
  let wolfCount = settings.wolves;
  if (settings.silencer && wolfCount > 0) {
    roles.push('silencer');
    wolfCount--;
  }
  for (let i = 0; i < wolfCount; i++) roles.push('wolf');

  // specials
  if (settings.doctor) roles.push('doctor');
  if (settings.detective) roles.push('detective');
  if (settings.blessed) roles.push('blessed');

  // fill civilians
  while (roles.length < players.length) roles.push('civilian');

  return shuffled.map((p, i) => ({ ...p, role: roles[i], eliminated: false, silenced: false, savedBy: null }));
}

function getRoom(code) { return rooms[code]; }

function broadcastRoom(code) {
  const room = getRoom(code);
  if (!room) return;
  // send each player their own role privately, others get masked
  room.players.forEach(p => {
    const socket = io.sockets.sockets.get(p.socketId);
    if (!socket) return;
    const payload = {
      ...room,
      players: room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        color: pl.color,
        eliminated: pl.eliminated,
        silenced: pl.silenced,
        votes: pl.votes,
        isChief: pl.isChief,
        chiefVotes: pl.chiefVotes,
        // reveal role only to self, or if eliminated, or to wolf teammates at night
        role: (pl.id === p.id || pl.eliminated ||
          (room.phase === 'night' && p.role === 'wolf' && (pl.role === 'wolf' || pl.role === 'silencer')) ||
          (room.phase === 'night' && p.role === 'silencer' && (pl.role === 'wolf' || pl.role === 'silencer'))
        ) ? pl.role : null
      })),
      myRole: p.role,
      myId: p.id,
      myIsChief: p.isChief
    };
    socket.emit('room:update', payload);
  });
}

function startSpeakerTimer(code) {
  const room = getRoom(code);
  if (!room) return;
  clearInterval(room.timerInterval);
  room.timerSec = 60;

  io.to(code).emit('timer:update', { sec: room.timerSec });

  room.timerInterval = setInterval(() => {
    if (!rooms[code]) { clearInterval(room.timerInterval); return; }
    room.timerSec--;
    io.to(code).emit('timer:update', { sec: room.timerSec });
    if (room.timerSec <= 0) {
      clearInterval(room.timerInterval);
      advanceSpeaker(code);
    }
  }, 1000);
}

function advanceSpeaker(code) {
  const room = getRoom(code);
  if (!room) return;
  const active = room.players.filter(p => !p.eliminated);
  if (!active.length) return;

  room.speakerIdx = (room.speakerIdx + 1) % active.length;
  const speaker = active[room.speakerIdx];

  // If we wrapped around, switch phase
  if (room.speakerIdx === 0) {
    if (room.phase === 'day') {
      room.phase = 'night';
      // reset votes
      room.players.forEach(p => { p.votes = 0; p.nightVote = null; });
      room.myVotes = {};
      io.to(code).emit('phase:change', { phase: 'night', round: room.round });
      io.to(code).emit('chat:system', '🌙 جاء الليل — الذياب تتحرك سراً!');
      // Night is automated — start night logic
      startNightTimer(code);
      return;
    } else {
      room.round++;
      room.phase = 'day';
      // reset day votes
      room.players.forEach(p => { p.votes = 0; p.nightVote = null; });
      room.myVotes = {};
      io.to(code).emit('phase:change', { phase: 'day', round: room.round });
      io.to(code).emit('chat:system', `☀️ صباح الجولة ${room.round}`);
      checkWinCondition(code);
    }
  }

  // skip silenced speaker during day
  if (room.phase === 'day' && speaker.silenced) {
    io.to(code).emit('chat:system', `🔕 ${speaker.name} مسكّت — يتخطى دوره`);
    // reset silenced after skip
    speaker.silenced = false;
    advanceSpeaker(code);
    return;
  }

  io.to(code).emit('speaker:change', { speakerId: speaker.id, speakerName: speaker.name });
  startSpeakerTimer(code);
  broadcastRoom(code);
}

function startNightTimer(code) {
  const room = getRoom(code);
  if (!room) return;
  clearInterval(room.timerInterval);
  room.timerSec = 40;
  io.to(code).emit('timer:update', { sec: room.timerSec });
  room.timerInterval = setInterval(() => {
    if (!rooms[code]) { clearInterval(room.timerInterval); return; }
    room.timerSec--;
    io.to(code).emit('timer:update', { sec: room.timerSec });
    if (room.timerSec <= 0) {
      clearInterval(room.timerInterval);
      resolveNight(code);
    }
  }, 1000);
}

function resolveNight(code) {
  const room = getRoom(code);
  if (!room) return;

  // Find wolf target (majority wolf vote)
  const wolfVotes = {};
  room.players.filter(p => !p.eliminated && (p.role === 'wolf' || p.role === 'silencer'))
    .forEach(p => { if (p.nightVote) wolfVotes[p.nightVote] = (wolfVotes[p.nightVote] || 0) + 1; });

  let wolfTarget = null;
  let maxV = 0;
  Object.entries(wolfVotes).forEach(([id, v]) => { if (v > maxV) { maxV = v; wolfTarget = id; } });

  // Doctor save
  const doctor = room.players.find(p => !p.eliminated && p.role === 'doctor');
  const doctorSave = doctor?.nightVote || null;

  // Detective check
  const detective = room.players.find(p => !p.eliminated && p.role === 'detective');
  if (detective?.nightVote) {
    const target = room.players.find(p => p.id === detective.nightVote);
    if (target) {
      const dSocket = io.sockets.sockets.get(detective.socketId);
      const isWolf = target.role === 'wolf' || target.role === 'silencer';
      dSocket?.emit('detective:result', { targetName: target.name, isWolf });
    }
  }

  // Silencer action
  const silencer = room.players.find(p => !p.eliminated && p.role === 'silencer');
  if (silencer?.nightVote && silencer.nightVote !== wolfTarget) {
    const silenceTarget = room.players.find(p => p.id === silencer.nightVote);
    if (silenceTarget) {
      silenceTarget.silenced = true;
      io.to(code).emit('chat:system', `🔕 لاعب تم تسكيته الليلة`);
    }
  }

  // Apply wolf kill
  if (wolfTarget && wolfTarget !== doctorSave) {
    const victim = room.players.find(p => p.id === wolfTarget);
    if (victim) {
      victim.eliminated = true;
      io.to(code).emit('chat:system', `🐺 الذياب هاجموا ${victim.name} الليلة!`);
      io.to(code).emit('player:eliminated', { playerId: victim.id, playerName: victim.name, role: victim.role });
      handleBlessedElimination(code, victim);
    }
  } else if (wolfTarget && wolfTarget === doctorSave) {
    io.to(code).emit('chat:system', `💊 الطبيب أنقذ شخصاً الليلة!`);
  }

  // reset night votes
  room.players.forEach(p => { p.nightVote = null; });

  // back to day
  room.phase = 'day';
  room.round++;
  room.players.forEach(p => { p.votes = 0; });
  room.myVotes = {};

  io.to(code).emit('phase:change', { phase: 'day', round: room.round });
  io.to(code).emit('chat:system', `☀️ صباح الجولة ${room.round}`);

  checkWinCondition(code);

  if (rooms[code]) {
    room.speakerIdx = 0;
    const active = room.players.filter(p => !p.eliminated);
    if (active.length > 0) {
      io.to(code).emit('speaker:change', { speakerId: active[0].id, speakerName: active[0].name });
      startSpeakerTimer(code);
    }
    broadcastRoom(code);
  }
}

function handleBlessedElimination(code, player) {
  if (player.role !== 'blessed') return;
  const room = getRoom(code);
  if (!room) return;
  const bSocket = io.sockets.sockets.get(player.socketId);
  bSocket?.emit('blessed:choose', {
    players: room.players.filter(p => !p.eliminated && p.id !== player.id).map(p => ({ id: p.id, name: p.name }))
  });
}

function resolveDayVote(code) {
  const room = getRoom(code);
  if (!room) return;
  let maxV = 0, target = null;
  room.players.filter(p => !p.eliminated).forEach(p => {
    if (p.votes > maxV) { maxV = p.votes; target = p; }
  });
  if (!target || maxV === 0) {
    io.to(code).emit('chat:system', '🗳️ ما كانش أغلبية — لا أحد يخرج اليوم');
    return;
  }
  target.eliminated = true;
  io.to(code).emit('chat:system', `🗳️ القرية صوّتت على ${target.name} — خرج من اللعبة!`);
  io.to(code).emit('player:eliminated', { playerId: target.id, playerName: target.name, role: target.role });
  handleBlessedElimination(code, target);
  checkWinCondition(code);
}

function checkWinCondition(code) {
  const room = getRoom(code);
  if (!room) return;
  const alive = room.players.filter(p => !p.eliminated);
  const wolves = alive.filter(p => p.role === 'wolf' || p.role === 'silencer');
  const villagers = alive.filter(p => p.role !== 'wolf' && p.role !== 'silencer');

  if (wolves.length === 0) {
    io.to(code).emit('game:over', { winner: 'village', message: 'فازت القرية! كل الذياب تم كشفهم 🎉' });
    delete rooms[code];
  } else if (wolves.length >= villagers.length) {
    io.to(code).emit('game:over', { winner: 'wolves', message: 'فاز الذياب! سيطروا على القرية 🐺' });
    delete rooms[code];
  }
}

// ─── Socket Events ───────────────────────────────────────────────────
io.on('connection', socket => {

  // CREATE ROOM
  socket.on('room:create', ({ playerName, settings }) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    const player = { id: uuidv4(), socketId: socket.id, name: playerName, color: randomColor(0), isHost: true, role: null, eliminated: false, silenced: false, votes: 0, chiefVotes: 0, isChief: false, nightVote: null };

    rooms[code] = {
      code,
      hostId: player.id,
      players: [player],
      settings: settings || { wolves: 2, silencer: true, doctor: true, detective: true, blessed: true, chief: true },
      phase: 'lobby',
      round: 0,
      speakerIdx: 0,
      timerSec: 0,
      timerInterval: null,
      myVotes: {},
      chiefVoteMap: {},
      chiefTimerInterval: null
    };

    socket.join(code);
    socket.emit('room:created', { code, playerId: player.id });
    broadcastRoom(code);
  });

  // JOIN ROOM
  socket.on('room:join', ({ code, playerName }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('error', { msg: '❌ الغرفة ما موجودتش' }); return; }
    if (room.phase !== 'lobby') { socket.emit('error', { msg: '❌ اللعبة بدأت بالفعل' }); return; }
    if (room.players.length >= 15) { socket.emit('error', { msg: '❌ الغرفة ممتلئة (15/15)' }); return; }
    if (room.players.find(p => p.name === playerName)) { socket.emit('error', { msg: '❌ الاسم مستخدم' }); return; }

    const player = { id: uuidv4(), socketId: socket.id, name: playerName, color: randomColor(room.players.length), isHost: false, role: null, eliminated: false, silenced: false, votes: 0, chiefVotes: 0, isChief: false, nightVote: null };

    room.players.push(player);
    socket.join(code);
    socket.emit('room:joined', { code, playerId: player.id });
    io.to(code).emit('chat:system', `👤 ${playerName} دخل للغرفة`);
    broadcastRoom(code);
  });

  // UPDATE SETTINGS (host only)
  socket.on('settings:update', ({ code, settings }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player?.isHost) return;
    room.settings = { ...room.settings, ...settings };
    broadcastRoom(code);
  });

  // START GAME
  socket.on('game:start', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player?.isHost) return;
    if (room.players.length < 6) { socket.emit('error', { msg: '❌ تحتاج على الأقل 6 لاعبين' }); return; }

    room.players = assignRoles(room.players, room.settings);

    if (room.settings.chief) {
      room.phase = 'chief_vote';
      room.chiefVoteMap = {};
      io.to(code).emit('phase:change', { phase: 'chief_vote', round: 0 });
      broadcastRoom(code);

      // Chief vote timer 30s
      let sec = 30;
      io.to(code).emit('timer:update', { sec });
      room.chiefTimerInterval = setInterval(() => {
        if (!rooms[code]) { clearInterval(room.chiefTimerInterval); return; }
        sec--;
        io.to(code).emit('timer:update', { sec });
        if (sec <= 0) { clearInterval(room.chiefTimerInterval); resolveChiefVote(code); }
      }, 1000);
    } else {
      launchMainGame(code);
    }
  });

  // CHIEF VOTE
  socket.on('chief:vote', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'chief_vote') return;
    const voter = room.players.find(p => p.socketId === socket.id);
    if (!voter) return;
    room.chiefVoteMap[voter.id] = targetId;
    // update vote counts for display
    room.players.forEach(p => {
      p.chiefVotes = Object.values(room.chiefVoteMap).filter(v => v === p.id).length;
    });
    broadcastRoom(code);
  });

  // CHIEF VOTE END (host can force end)
  socket.on('chief:end', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player?.isHost) return;
    clearInterval(room.chiefTimerInterval);
    resolveChiefVote(code);
  });

  // DAY VOTE
  socket.on('day:vote', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'day') return;
    const voter = room.players.find(p => p.socketId === socket.id);
    if (!voter || voter.eliminated) return;

    const voteWeight = voter.isChief ? 3 : 1;
    const prevTarget = room.myVotes[voter.id];
    if (prevTarget) {
      const prev = room.players.find(p => p.id === prevTarget);
      if (prev) prev.votes = Math.max(0, prev.votes - voteWeight);
    }

    if (prevTarget === targetId) {
      delete room.myVotes[voter.id];
    } else {
      room.myVotes[voter.id] = targetId;
      const target = room.players.find(p => p.id === targetId);
      if (target) target.votes += voteWeight;
    }
    broadcastRoom(code);
  });

  // NIGHT VOTE (wolf/doctor/detective)
  socket.on('night:vote', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night') return;
    const voter = room.players.find(p => p.socketId === socket.id);
    if (!voter || voter.eliminated) return;
    voter.nightVote = targetId;
    socket.emit('night:vote:ack', { targetId });
  });

  // FORCE DAY VOTE RESOLVE (host)
  socket.on('day:resolve', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player?.isHost) return;
    clearInterval(room.timerInterval);
    resolveDayVote(code);
    // move to night
    room.phase = 'night';
    room.players.forEach(p => { p.votes = 0; p.nightVote = null; });
    room.myVotes = {};
    io.to(code).emit('phase:change', { phase: 'night', round: room.round });
    io.to(code).emit('chat:system', '🌙 جاء الليل!');
    startNightTimer(code);
    broadcastRoom(code);
  });

  // SKIP/DONE SPEAKER
  socket.on('speaker:skip', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    clearInterval(room.timerInterval);
    advanceSpeaker(code);
  });

  // BLESSED CHOICE
  socket.on('blessed:choice', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room) return;
    const target = room.players.find(p => p.id === targetId);
    if (target) {
      target.eliminated = true;
      io.to(code).emit('chat:system', `😇 الولد الصالح اختار ${target.name} يخرج معه`);
      io.to(code).emit('player:eliminated', { playerId: target.id, playerName: target.name, role: target.role });
      checkWinCondition(code);
      broadcastRoom(code);
    }
  });

  // CHAT MESSAGE
  socket.on('chat:message', ({ code, text }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.eliminated) return;
    if (!text || text.trim().length === 0) return;
    const clean = text.trim().substring(0, 200);
    io.to(code).emit('chat:message', { author: player.name, text: clean, color: player.color });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(code => {
      const room = rooms[code];
      if (!room) return;
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx === -1) return;
      const player = room.players[idx];
      io.to(code).emit('chat:system', `👤 ${player.name} خرج من اللعبة`);
      if (room.phase === 'lobby') {
        room.players.splice(idx, 1);
        if (room.players.length === 0) { delete rooms[code]; return; }
        if (player.isHost && room.players.length > 0) {
          room.players[0].isHost = true;
          room.hostId = room.players[0].id;
          io.to(code).emit('chat:system', `👑 ${room.players[0].name} أصبح المضيف الجديد`);
        }
        broadcastRoom(code);
      } else {
        player.eliminated = true;
        checkWinCondition(code);
        broadcastRoom(code);
      }
    });
  });
});

function resolveChiefVote(code) {
  const room = getRoom(code);
  if (!room) return;
  let maxV = 0, chiefPlayer = null;
  room.players.forEach(p => {
    const c = Object.values(room.chiefVoteMap).filter(v => v === p.id).length;
    if (c > maxV) { maxV = c; chiefPlayer = p; }
  });
  if (chiefPlayer) {
    chiefPlayer.isChief = true;
    io.to(code).emit('chat:system', `👴 ${chiefPlayer.name} أصبح شيخ القبيلة — صوته يساوي 3 أصوات!`);
  }
  launchMainGame(code);
}

function launchMainGame(code) {
  const room = getRoom(code);
  if (!room) return;
  room.phase = 'day';
  room.round = 1;
  room.speakerIdx = 0;
  room.myVotes = {};
  room.players.forEach(p => { p.votes = 0; p.nightVote = null; });
  io.to(code).emit('phase:change', { phase: 'day', round: 1 });
  io.to(code).emit('chat:system', '🐺 اللعبة بدأت! النهار الأول — كل واحد يتكلم ويدافع عن نفسه');
  broadcastRoom(code);
  const active = room.players.filter(p => !p.eliminated);
  if (active.length > 0) {
    io.to(code).emit('speaker:change', { speakerId: active[0].id, speakerName: active[0].name });
    startSpeakerTimer(code);
  }
}

const PLAYER_COLORS = ['#c8a84b','#e74c3c','#3498db','#2ecc71','#9b59b6','#e67e22','#1abc9c','#e91e63','#f39c12','#16a085','#8e44ad','#27ae60','#2980b9','#d35400','#c0392b'];
function randomColor(idx) { return PLAYER_COLORS[idx % PLAYER_COLORS.length]; }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🐺 ليلة الذياب تشتغل على البورت ${PORT}`));
