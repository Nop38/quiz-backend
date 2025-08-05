// 🟠 Imports
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const express = require("express");
const http = require("http");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const { Server } = require("socket.io");

// 🟠 Setup express + socket
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://quiz-frontend-alpha-amber.vercel.app",
    credentials: true,
  },
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "quiz123@38118";
const SESSION_COOKIE = "quiz_session";

// 🟠 Middleware
app.use(cors({
  origin: "https://quiz-frontend-alpha-amber.vercel.app",
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

app.use((req, res, next) => {
  if (req.path === "/login" || req.path === "/check" || req.path === "/favicon.ico") return next();
  const token = req.cookies?.[SESSION_COOKIE];
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// 🟠 Auth routes
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.cookie(SESSION_COOKIE, ADMIN_PASSWORD, {
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
    });
    return res.json({ success: true });
  } else {
    return res.status(401).json({ success: false, error: "Mot de passe incorrect" });
  }
});

app.get("/check", (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token === ADMIN_PASSWORD) {
    return res.sendStatus(200);
  } else {
    return res.sendStatus(401);
  }
});

// 🟠 Chargement CSV (comme avant, inchangé)
let QUESTION_BANK = [], SCENES = [], ACTORS = [], STARS = [];

function safeParseCSV(filePath, opts) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return parse(raw, opts);
  } catch (err) {
    console.error("Erreur CSV:", err.message);
    return [];
  }
}

function loadCSVData() {
  const basePath = __dirname;

  const config = [
    { file: "questions_culture_generale_tres_variees.csv", target: QUESTION_BANK, delimiter: ";", mapper: (r) => ({ text: r.question?.trim(), answer: r.reponse?.trim(), image: r.image?.trim() || null }) },
    { file: "tmdb_scenes.csv", target: SCENES, delimiter: ",", mapper: (r) => ({ title: r.title?.trim(), url: r.url?.trim() }) },
    { file: "actors_500.csv", target: ACTORS, delimiter: ",", mapper: (r) => ({ name: r.name?.trim(), url: r.photo_url?.trim() }) },
    { file: "stars.csv", target: STARS, delimiter: ",", mapper: (r) => ({ name: r.name?.trim(), url: r.photo_url?.trim() }) },
  ];

  for (const { file, target, delimiter, mapper } of config) {
    const p = path.join(basePath, file);
    if (!fs.existsSync(p)) continue;

    const rows = safeParseCSV(p, {
      columns: true,
      skip_empty_lines: true,
      delimiter,
      trim: true,
    });

    const cleaned = rows.map(mapper).filter((o) => Object.values(o).every(Boolean));
    target.splice(0, target.length, ...cleaned);
  }
}

loadCSVData();

// 🟠 Quiz generation
const NB_Q = 20, MIN_SCENES = 3, MIN_ACTORS = 2, MIN_STARS = 2;
const SCENE_RATIO = 0.25, ACTOR_RATIO = 0.15, STAR_RATIO = 0.15;
const shuffle = (a) => a.sort(() => Math.random() - 0.5);

function buildQuestions() {
  let nbScenes = Math.max(Math.round(NB_Q * SCENE_RATIO), MIN_SCENES);
  nbScenes = Math.min(nbScenes, SCENES.length);

  let nbActors = Math.max(Math.round(NB_Q * ACTOR_RATIO), MIN_ACTORS);
  nbActors = Math.min(nbActors, ACTORS.length, NB_Q - nbScenes);

  let nbStars = Math.max(Math.round(NB_Q * STAR_RATIO), MIN_STARS);
  nbStars = Math.min(nbStars, STARS.length, NB_Q - nbScenes - nbActors);

  const nbCulture = NB_Q - nbScenes - nbActors - nbStars;

  const capitales = QUESTION_BANK.filter(q => /capitale/i.test(q.text));
  const autres = QUESTION_BANK.filter(q => !/capitale/i.test(q.text));
  const culture = shuffle([...capitales.slice(0, 2), ...autres.slice(0, nbCulture - 2)]);

  const scenes = shuffle(SCENES).slice(0, nbScenes).map((s) => ({ text: "De quel film cette scène provient ?", answer: s.title, image: s.url }));
  const actors = shuffle(ACTORS).slice(0, nbActors).map((a) => ({ text: "Qui est cette personnalité ?", answer: a.name, image: a.url }));
  const stars = shuffle(STARS).slice(0, nbStars).map((s) => ({ text: "Qui est ce sportif ?", answer: s.name, image: s.url }));

  return shuffle([...culture, ...scenes, ...actors, ...stars]).slice(0, NB_Q);
}

// 🟠 Lobbies & utils
const lobbies = {};
const gid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const pid = () => Math.random().toString(36).slice(2, 12);
const arrP = (l) => Object.values(l.players).map((p) => ({ ...p }));
const answered = (a) => a != null && String(a).trim() !== "";

function everyoneAnsweredQuestion(lobby, qIdx) {
  return Object.values(lobby.players).every((p) => answered(p.answers[qIdx]));
}

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

// 🟠 Socket.IO
io.on("connection", (sock) => {
  sock.on("createLobby", ({ name, avatar }) => {
    const questions = buildQuestions();
    const lobbyId = gid();
    const token = pid();

    lobbies[lobbyId] = {
      id: lobbyId,
      creatorToken: token,
      phase: "lobby",
      currentQ: 0,
      questions,
      players: {
        [token]: {
          id: sock.id,
          token,
          name,
          avatar,
          score: 0,
          answers: Array(questions.length).fill(null),
        },
      },
      validations: {},
      timer: null,
    };

    sock.join(lobbyId);
    sock.emit("lobbyCreated", { lobbyId, token, questions, isCreator: true });
    emitState(lobbyId);
  });

  sock.on("joinLobby", ({ lobbyId, name, avatar }) => {
    const l = lobbies[lobbyId];
    const token = pid();

    l.players[token] = {
      id: sock.id,
      token,
      name,
      avatar,
      score: 0,
      answers: Array(l.questions.length).fill(null),
    };

    sock.join(lobbyId);
    sock.emit("lobbyJoined", { lobbyId, token, questions: l.questions, isCreator: false });
    emitState(lobbyId);
  });

  sock.on("startQuiz", ({ lobbyId, token }) => {
    const l = lobbies[lobbyId];
    if (l.creatorToken !== token) return;
    broadcastPhase(lobbyId, "quiz");
    startQuestionTimer(l);
    emitState(lobbyId);
  });

  sock.on("submitAnswer", ({ lobbyId, token, questionIndex, answer }) => {
    const l = lobbies[lobbyId];
    const p = l.players[token];
    p.answers[questionIndex] = answer;

    io.to(p.id).emit("answerAck", { questionIndex });

    if (everyoneAnsweredQuestion(l, l.currentQ)) {
      clearTimeout(l.timer);
      proceedToNextOrValidation(l);
    } else {
      emitState(lobbyId);
    }
  });

  sock.on("validateAnswer", ({ lobbyId, token, playerToken, questionIndex, isCorrect }) => {
    const l = lobbies[lobbyId];
    if (l.creatorToken !== token) return;

    l.validations[playerToken][questionIndex] = isCorrect;
    if (isCorrect) l.players[playerToken].score++;

    const finishedQ = Object.values(l.validations).every((arr) => arr[questionIndex] !== null);
    if (finishedQ) {
      if (l.currentQ < l.questions.length - 1) {
        l.currentQ++;
        emitState(lobbyId);
      } else {
        broadcastPhase(lobbyId, "result");
        io.to(lobbyId).emit("validationEnded", { classement: arrP(l).sort((a, b) => b.score - a.score) });
      }
    } else {
      emitState(lobbyId);
    }
  });
});

// ⏱ Gestion du timer
function startQuestionTimer(lobby) {
  if (lobby.timer) clearTimeout(lobby.timer);

  lobby.timer = setTimeout(() => {
    proceedToNextOrValidation(lobby);
  }, 20000);
}

function proceedToNextOrValidation(lobby) {
  if (lobby.currentQ < lobby.questions.length - 1) {
    lobby.currentQ++;
    startQuestionTimer(lobby);
    emitState(lobby.id);
  } else {
    broadcastPhase(lobby.id, "validation");
    lobby.validations = {};
    Object.keys(lobby.players).forEach((t) => {
      lobby.validations[t] = Array(lobby.questions.length).fill(null);
    });
    emitState(lobby.id);
  }
}

server.listen(process.env.PORT || 4000, "0.0.0.0", () => {
  console.log("Quiz server ready");
});
