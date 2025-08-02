const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* =======================
   Chargement des CSV
   ======================= */

let QUESTION_BANK = [];
let SCENES = [];
let ACTORS = [];
let STARS = [];

function safeParseCSV(filePath, opts) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return parse(raw, opts);
  } catch (err) {
    console.error("Erreur CSV:", err.message);
    return [];
  }
}

function loadCultureCSV() {
  const p = path.join(__dirname, "questions_culture_generale_tres_variees.csv");
  if (!fs.existsSync(p)) return;

  const rows = safeParseCSV(p, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ";",
    trim: true,
  });

  const seen = new Set();

  QUESTION_BANK = rows
    .map((r) => {
      const text = (r.question || r.text || "").trim();
      const answer = (r.reponse || r.answer || "").trim();
      const image = (r.image || "").trim() || null;
      return { text, answer, image };
    })
    .filter((q) => q.text && q.answer)
    .filter((q) => {
      const k = `${q.text}__${q.answer}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

function loadScenesCSV() {
  const p = path.join(__dirname, "tmdb_scenes.csv");
  if (!fs.existsSync(p)) return;

  const rows = safeParseCSV(p, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ",",
    trim: true,
  });

  SCENES = rows
    .map((r) => ({
      title: (r.title || r.film || r.movie || "").trim(),
      url: (r.url || r.image || r.img || "").trim(),
    }))
    .filter((s) => s.title && s.url);
}

function loadActorsCSV() {
  const p = path.join(__dirname, "actors_500.csv");
  if (!fs.existsSync(p)) return;

  const rows = safeParseCSV(p, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ",",
    trim: true,
  });

  ACTORS = rows
    .map((r) => ({
      name: (r.name || "").trim(),
      url: (r.photo_url || r.url || "").trim(),
    }))
    .filter((a) => a.name && a.url);
}

function loadStarsCSV() {
  const p = path.join(__dirname, "stars.csv");
  if (!fs.existsSync(p)) return;

  const rows = safeParseCSV(p, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ",",
    trim: true,
  });

  STARS = rows
    .map((r) => ({
      name: (r.name || "").trim(),
      url: (r.photo_url || r.url || "").trim(),
    }))
    .filter((s) => s.name && s.url);
}

loadCultureCSV();
loadScenesCSV();
loadActorsCSV();
loadStarsCSV();

/* =======================
   Paramètres quiz 
   ======================= */
const NB_Q = 20;
const SCENE_RATIO = 0.25;
const ACTOR_RATIO = 0.15;
const STAR_RATIO = 0.15;

const MIN_SCENES = 3;
const MIN_ACTORS = 2;
const MIN_STARS = 2;

const shuffle = (a) => a.sort(() => Math.random() - 0.5);

function buildQuestions() {
  if (!QUESTION_BANK.length && !SCENES.length && !ACTORS.length && !STARS.length) return [];

  let nbScenes = Math.max(Math.round(NB_Q * SCENE_RATIO), MIN_SCENES);
  nbScenes = Math.min(nbScenes, SCENES.length, NB_Q);

  let nbActors = Math.max(Math.round(NB_Q * ACTOR_RATIO), MIN_ACTORS);
  nbActors = Math.min(nbActors, ACTORS.length, NB_Q - nbScenes);

  let nbStars = Math.max(Math.round(NB_Q * STAR_RATIO), MIN_STARS);
  nbStars = Math.min(nbStars, STARS.length, NB_Q - nbScenes - nbActors);

  const nbCulture = NB_Q - nbScenes - nbActors - nbStars;

  const capitales = QUESTION_BANK.filter(q => /capitale/i.test(q.text));
  const autres = QUESTION_BANK.filter(q => !/capitale/i.test(q.text));
  const selectedCapitales = shuffle(capitales).slice(0, 2);
  const selectedAutres = shuffle(autres).slice(0, nbCulture - selectedCapitales.length);
  const culture = shuffle([...selectedCapitales, ...selectedAutres]);

  const scenes = shuffle([...SCENES])
    .slice(0, nbScenes)
    .map((s) => ({
      text: "De quel film cette scène provient ?",
      answer: s.title,
      image: s.url,
    }));

  const actors = shuffle([...ACTORS])
    .slice(0, nbActors)
    .map((a) => ({
      text: "Qui est cette personnalité ?",
      answer: a.name,
      image: a.url,
    }));

  const stars = shuffle([...STARS])
    .slice(0, nbStars)
    .map((s) => ({
      text: "Qui est ce sportif ?",
      answer: s.name,
      image: s.url,
    }));

  
  const fixedQuestion = {
    text: "Est ce que cet homme est beau ?",
    answer: "oui bien sur",
    image: "data/10.webp",
  };

const combined = shuffle([...scenes, ...actors, ...stars, ...culture]);
  const seen = new Set();
  
  const out = [];
  let inserted = false;
  for (const q of combined) {
    const k = `${q.text}__${q.answer}`;
    if (!seen.has(k)) {
      seen.add(k);
      if (out.length === 9 && !inserted) {
        out.push(fixedQuestion); // insertion en 10e position
        inserted = true;
      }
      out.push(q);
      if (out.length === NB_Q) break;
    }
  }
  if (!inserted && out.length < NB_Q) {
    out.splice(9, 0, fixedQuestion);
  }
  return out;

}

/* =======================
   Utils / Lobby state
   ======================= */
const answered = (a) => a != null && String(a).trim() !== "";
const everyoneFinished = (players) =>
  Object.values(players).every((pl) => pl.answers.every(answered));

const lobbies = {};
const gid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const pid = () => Math.random().toString(36).slice(2, 12);

const arrP = (l) =>
  Object.values(l.players).map(({ id, name, score, answers, token, avatar }) => ({
    id,
    name,
    score,
    answers,
    token,
    avatar,
  }));

function emitState(lobbyId) {
  const l = lobbies[lobbyId];
  if (!l) return;
  io.to(lobbyId).emit("stateSync", {
    phase: l.phase,
    questionIndex: l.currentQ,
    players: arrP(l),
    questions: l.questions,
    validations: l.validations,
  });
}

function broadcastPhase(lobbyId, phase) {
  const l = lobbies[lobbyId];
  if (!l) return;
  l.phase = phase;
  io.to(lobbyId).emit("phaseChange", { phase });
}

function initValidations(l) {
  l.validations = {};
  Object.keys(l.players).forEach((t) => {
    l.validations[t] = Array(l.questions.length).fill(null);
  });
}

/* =======================
   Socket.IO
   ======================= */
io.on("connection", (sock) => {
  sock.on("createLobby", ({ name, avatar }) => {
    const questions = buildQuestions();
    if (!questions.length) return sock.emit("errorMsg", "Aucune question dispo.");

    const lobbyId = gid();
    const token = pid();

    lobbies[lobbyId] = {
      id: lobbyId,
      creatorToken: token,
      creatorId: sock.id,
      phase: "lobby",
      currentQ: 0,
      questions,
      players: {
        [token]: {
          id: sock.id,
          token,
          name,
          avatar: avatar || null,
          score: 0,
          answers: Array(questions.length).fill(null),
        },
      },
      validations: {},
    };

    sock.join(lobbyId);
    sock.emit("lobbyCreated", {
      lobbyId,
      token,
      questions,
      isCreator: true,
      avatar: avatar || null,
    });
    io.to(lobbyId).emit("playersUpdate", arrP(lobbies[lobbyId]));
    emitState(lobbyId);
  });

  sock.on("joinLobby", ({ lobbyId, name, avatar }) => {
    const l = lobbies[lobbyId];
    if (!l) return sock.emit("errorMsg", "Lobby introuvable.");

    const token = pid();
    l.players[token] = {
      id: sock.id,
      token,
      name,
      avatar: avatar || null,
      score: 0,
      answers: Array(l.questions.length).fill(null),
    };

    sock.join(lobbyId);
    sock.emit("lobbyJoined", {
      lobbyId,
      token,
      questions: l.questions,
      isCreator: false,
      avatar: avatar || null,
    });
    io.to(lobbyId).emit("playersUpdate", arrP(l));
    emitState(lobbyId);
  });

  sock.on("rejoinLobby", ({ lobbyId, token }) => {
    const l = lobbies[lobbyId];
    const p = l?.players[token];
    if (!l || !p) return sock.emit("errorMsg", "Session expirée. Relance une partie.");

    p.id = sock.id;
    sock.join(lobbyId);
    sock.emit("rejoinSuccess", {
      phase: l.phase,
      lobbyId,
      token,
      isCreator: token === l.creatorToken,
      currentQ: l.currentQ,
      questions: l.questions,
      players: arrP(l),
      validations: l.validations,
    });
    io.to(lobbyId).emit("playersUpdate", arrP(l));
    emitState(lobbyId);
  });

  sock.on("requestState", ({ lobbyId }) => emitState(lobbyId));

  sock.on("startQuiz", ({ lobbyId, token }) => {
    const l = lobbies[lobbyId];
    if (!l || l.creatorToken !== token) return;
    broadcastPhase(lobbyId, "quiz");
    io.to(lobbyId).emit("quizStarted");
    emitState(lobbyId);
  });

  sock.on("submitAnswer", ({ lobbyId, token, questionIndex, answer, timedOut }) => {
    const l = lobbies[lobbyId];
    const p = l?.players[token];
    if (!p || l.phase !== "quiz") return;

    p.answers[questionIndex] = answer;

    io.to(p.id).emit("answerAck", { questionIndex, timedOut: !!timedOut });
    io.to(lobbyId).emit("playersUpdate", arrP(l));

    if (everyoneFinished(l.players)) {
      l.currentQ = 0;
      initValidations(l);

      const payload = {
        phase: "validation",
        questionIndex: 0,
        players: arrP(l),
        questions: l.questions,
        validations: l.validations,
      };
      io.to(lobbyId).emit("startValidation", payload);
      broadcastPhase(lobbyId, "validation");
      emitState(lobbyId);
    } else {
      emitState(lobbyId);
    }
  });

  sock.on("validateAnswer", ({ lobbyId, token, playerToken, questionIndex, isCorrect }) => {
    const l = lobbies[lobbyId];
    if (!l || l.creatorToken !== token || l.phase !== "validation") return;

    l.validations[playerToken][questionIndex] = isCorrect;
    if (isCorrect) l.players[playerToken].score++;

    io.to(lobbyId).emit("validationUpdated", {
      playerId: playerToken,
      questionIndex,
      isCorrect,
      score: l.players[playerToken].score,
    });

    const finishedQ = Object.values(l.validations).every((arr) => arr[questionIndex] !== null);
    if (finishedQ) {
      if (l.currentQ < l.questions.length - 1) {
        l.currentQ++;
        const payload = {
          phase: "validation",
          questionIndex: l.currentQ,
          players: arrP(l),
          questions: l.questions,
          validations: l.validations,
        };
        io.to(lobbyId).emit("startValidation", payload);
        emitState(lobbyId);
      } else {
        broadcastPhase(lobbyId, "result");
        const classement = arrP(l).sort((a, b) => b.score - a.score);
        io.to(lobbyId).emit("validationEnded", { classement });
        emitState(lobbyId);
      }
    } else {
      emitState(lobbyId);
    }
  });

  sock.on("leaveLobby", ({ lobbyId, token }) => {
    const l = lobbies[lobbyId];
    if (!l) return;
    delete l.players[token];
    io.to(lobbyId).emit("playersUpdate", arrP(l));

    if (!Object.keys(l.players).length) {
      delete lobbies[lobbyId];
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, "0.0.0.0", () => console.log(`WS :${PORT} — Quiz OK`));
