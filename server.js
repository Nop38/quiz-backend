/* ────────────────────────────────
   QUIZ BACK‑END (avatars, timeouts, validations, classement)
   CSV culture générale séparé par « ; »
   ──────────────────────────────── */

const fs           = require("fs");
const path         = require("path");
const { parse }    = require("csv-parse/sync");
const express      = require("express");
const http         = require("http");
const { Server }   = require("socket.io");

const app    = express();
const server = http.createServer(app);
const io      = new Server(server, { cors: { origin: "*" } });

/* =======================
   Constantes
   ======================= */
const NB_Q        = 20;         // valeur par défaut si le créateur n’en choisit pas
const SCENE_RATIO = 0.25;       // % de questions “scènes de film”
const MIN_SCENES  = 3;          // minimum de scènes à insérer

/* =======================
   Helpers CSV + chargement
   ======================= */
function safeParseCSV(filePath, opts) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return parse(raw, opts);
  } catch (err) {
    console.error("Erreur CSV:", err.message);
    return [];
  }
}

let QUESTION_BANK = [];
let SCENES        = [];

function loadCultureCSV() {
  const p = path.join(__dirname, "questions_culture_generale_tres_variees.csv");
  if (!fs.existsSync(p)) return;
  const rows = safeParseCSV(p, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ";",
    trim: true,
  });
  QUESTION_BANK = rows.map((r) => [r.question, r.answer]);
}

function loadScenesCSV() {
  const p = path.join(__dirname, "tmdb_scenes.csv");
  if (!fs.existsSync(p)) return;
  const rows = safeParseCSV(p, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ";",
    trim: true,
  });
  SCENES = rows.map((r) => ({ title: r.title, url: r.url }));
}

loadCultureCSV();
loadScenesCSV();

/* =======================
   Utils divers
   ======================= */
const gid  = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const pid  = () => Math.random().toString(36).slice(2, 10);
const rnd  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

/* =======================
   Génère la liste de questions
   ======================= */
function buildQuestions(nb = NB_Q) {
  if (!QUESTION_BANK.length && !SCENES.length) return [];

  /* mix scènes / culture */
  let nbScenes = Math.max(Math.round(nb * SCENE_RATIO), MIN_SCENES);
  nbScenes     = Math.min(nbScenes, SCENES.length, nb);
  const nbCulture = nb - nbScenes;

  const scenes = shuffle([...SCENES])
    .slice(0, nbScenes)
    .map((s) => ({
      text:   "De quel film cette scène provient ?",
      answer: s.title,
      image:  s.url,
    }));

  const culture = shuffle([...QUESTION_BANK])
    .slice(0, nbCulture)
    .map(([q, a]) => ({ text: q, answer: a }));

  const combined = shuffle([...scenes, ...culture]);

  /* dé‑duplication de sécurité */
  const seen = new Set();
  const out  = [];
  for (const q of combined) {
    const k = `${q.text}__${q.answer}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(q);
      if (out.length === nb) break;
    }
  }
  return out;
}

/* =======================
   Socket.IO
   ======================= */
const lobbies = {};

io.on("connection", (sock) => {
  /* CREATE */
  sock.on("createLobby", ({ name, avatar, nbQuestions }) => {
    const n          = [10, 20, 30, 40].includes(nbQuestions) ? nbQuestions : NB_Q;
    const questions  = buildQuestions(n);
    if (!questions.length)
      return sock.emit("errorMsg", "Aucune question dispo.");

    const lobbyId = gid();
    const token   = pid();

    lobbies[lobbyId] = {
      id:           lobbyId,
      creatorToken: token,
      creatorId:    sock.id,
      phase:        "lobby",
      currentQ:     0,
      questions,
      players: {
        [token]: {
          id:     sock.id,
          token,
          name,
          avatar: avatar || null,
          score:  0,
          answers: Array(questions.length).fill(null),
        },
      },
      validations: { [token]: Array(questions.length).fill(null) },
    };

    sock.join(lobbyId);
    sock.emit("lobbyCreated", {
      lobbyId,
      token,
      questions,
      isCreator: true,
      avatar: avatar || null,
    });
    io.to(lobbyId).emit("playersUpdate", Object.values(lobbies[lobbyId].players));
    emitState(lobbyId);
  });

  /* JOIN */
  sock.on("joinLobby", ({ lobbyId, name, avatar }) => {
    /* … (code inchangé) … */
  });

  /* START, ANSWERS, etc. (inchangés) */
});

/* =======================
   HTTP + Listen
   ======================= */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log("Back‑end listening on", PORT));

