/* ────────────────────────────────
   QUIZ BACK-END (avatars, timeouts, validations, classement)
   CSV culture générale séparé par « ; »
   ──────────────────────────────── */

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

  // Le fichier est en « ; » → on précise delimiter
  const rows = safeParseCSV(p, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ";",
    trim: true,
  });

  const seen = new Set();

  QUESTION_BANK = rows
    .map((r) => {
      // Adapter à tes colonnes exactes
      // Header attendu : id;theme;soustheme;type;question;reponse
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

loadCultureCSV();
loadScenesCSV();

/* =======================
   Paramètres quiz
   ======================= */
const NB_Q = 20;                 // nombre de questions par partie
const SCENE_RATIO = 0.25;       // % de questions "scènes de film"
const MIN_SCENES = 3;           // min de scènes à insérer
const shuffle = (a) => a.sort(() => Math.random() - 0.5);

/* Génère la liste de questions */
function buildQuestions() {
  if (!QUESTION_BANK.length && !SCENES.length) return [];

  let nbScenes = Math.max(Math.round(NB_Q * SCENE_RATIO), MIN_SCENES);
  nbScenes = Math.min(nbScenes, SCENES.length, NB_Q);
  const nbCulture = NB_Q - nbScenes;

  const scenes = shuffle([...SCENES])
    .slice(0, nbScenes)
    .map((s) => ({
      text: "De quel film cette scène provient ?",
      answer: s.title,
      image: s.url,
    }));

  const culture = shuffle([...QUESTION_BANK])
    .slice(0, nbCulture)
    .map((q) => ({
      text: q.text,
      answer: q.answer,
      image: q.image || null,
    }));

  const combined = shuffle([...scenes, ...culture]);
  const seen = new Set();
  const out = [];
  for (const q of combined) {
    const k = `${q.text}__${q.answer}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(q);
      if (out.length === NB_Q) break;
    }
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

/** Map joueurs en tableau propre pour le front */
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
  /* CREATE */
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

  /* JOIN */
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

  /* REJOIN */
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

  /* START QUIZ */
  sock.on("startQuiz", ({ lobbyId, token }) => {
    const l = lobbies[lobbyId];
    if (!l || l.creatorToken !== token) return;
    broadcastPhase(lobbyId, "quiz");
    io.to(lobbyId).emit("quizStarted");
    emitState(lobbyId);
  });

  /* SUBMIT ANSWER */
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

  /* VALIDATE ANSWER */
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

  /* LEAVE LOBBY / ABANDON */
  sock.on("leaveLobby", ({ lobbyId, token }) => {
    const l = lobbies[lobbyId];
    if (!l) return;
    delete l.players[token];
    io.to(lobbyId).emit("playersUpdate", arrP(l));

    // Si plus personne → supprimer lobby
    if (!Object.keys(l.players).length) {
      delete lobbies[lobbyId];
    }
  });
});

const PORT = process.env.PORT || 4000;      // Render fournit PORT
server.listen(PORT, "0.0.0.0", () => console.log(`WS :${PORT} — Quiz OK`));
