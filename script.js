import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  signInWithCustomToken,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

/* ==========================================
           配置 Firebase
           ========================================== */
let firebaseConfig;
let appId = "word-buzzer-game";

if (typeof __firebase_config !== "undefined") {
  firebaseConfig = JSON.parse(__firebase_config);
  if (typeof __app_id !== "undefined") appId = __app_id;
} else {
  firebaseConfig = {
    apiKey: "AIzaSyDpo4XeuQ-CpUBrRjfp9F6lHodCaHnPEPA",
    authDomain: "engchivocmanypeoplevs.firebaseapp.com",
    projectId: "engchivocmanypeoplevs",
    storageBucket: "engchivocmanypeoplevs.firebasestorage.app",
    messagingSenderId: "756895087254",
    appId: "1:756895087254:web:cb718b984540fbaf0220b7",
    measurementId: "G-QRQMKRH1QP",
  };
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ==========================================
           全域變數與遊戲狀態
           ========================================== */
let myUid = null;
let myName = "";

const GLOBAL_ROOM_ID = "GLOBAL_GAME_ROOM";
let currentRoomId = GLOBAL_ROOM_ID;

let isHost = false;
let roomUnsubscribe = null;
let localRoomState = null;
let hasSpokenThisRound = false;
let answerTimerInterval = null;
let nextRoundTimeoutId = null;

// 預設測試單詞
let gameWords = [
  { en: "apple", zh: "蘋果" },
  { en: "banana", zh: "香蕉" },
  { en: "computer", zh: "電腦" },
  { en: "snake", zh: "蛇" },
];

const gasUrl = "word.json";

fetch(gasUrl)
  .then((response) => response.json())
  .then((data) => {
    if (data && data.words && data.words.length > 0) {
      gameWords = data.words;
      const msgEl = document.getElementById("loading-words-msg");
      msgEl.textContent = `✅ 字庫已成功載入 (${gameWords.length} 個單詞)`;
      msgEl.classList.replace("text-gray-500", "text-green-600");
      msgEl.classList.remove("animate-pulse");
    }
  })
  .catch((err) => {
    console.error("載入字庫失敗:", err);
    const msgEl = document.getElementById("loading-words-msg");
    msgEl.textContent = "⚠️ 載入字庫失敗，將使用內建測試單詞";
    msgEl.classList.replace("text-gray-500", "text-red-500");
    msgEl.classList.remove("animate-pulse");
  });

/* ==========================================
           DOM 元素綁定
           ========================================== */
const UI = {
  screens: {
    home: document.getElementById("screen-home"),
    lobby: document.getElementById("screen-lobby"),
    game: document.getElementById("screen-game"),
    finished: document.getElementById("screen-finished"),
  },
  home: {
    name: document.getElementById("input-name"),
    btnEnter: document.getElementById("btn-enter-game"),
    btnForceReset: document.getElementById("btn-force-reset"),
  },
  lobby: {
    playerList: document.getElementById("player-list"),
    playerCount: document.getElementById("player-count"),
    btnStart: document.getElementById("btn-start-game"),
    waitMsg: document.getElementById("wait-host-msg"),
  },
  game: {
    statusText: document.getElementById("game-status-text"),
    chineseWord: document.getElementById("chinese-word"),
    answerSection: document.getElementById("answer-section"),
    inputAnswer: document.getElementById("input-answer"),
    btnSubmit: document.getElementById("btn-submit-answer"),
    roundResultSection: document.getElementById("round-result-section"),
    roundWinnerName: document.getElementById("round-winner-name"),
    correctAnswerText: document.getElementById("correct-answer-text"),
    scoreboard: document.getElementById("scoreboard-list"),
    currentRound: document.getElementById("current-round-text"),
  },
  finished: {
    winnerName: document.getElementById("final-winner-name"),
    winnerScore: document.getElementById("final-winner-score"),
    btnRestartLobby: document.getElementById("btn-restart-lobby"),
    waitRestartMsg: document.getElementById("wait-restart-msg"),
    btnShowFailedWords: document.getElementById("btn-show-failed-words"),
    failedWordsContainer: document.getElementById("failed-words-container"),
    failedWordsList: document.getElementById("failed-words-list"),
  },
};

/* ==========================================
           通用輔助函數
           ========================================== */
function showScreen(screenName) {
  Object.values(UI.screens).forEach((s) => s.classList.add("hidden-screen"));
  UI.screens[screenName].classList.remove("hidden-screen");
}

function showMsg(text) {
  const msgBox = document.getElementById("msg-box");
  document.getElementById("msg-text").textContent = text;
  msgBox.classList.remove("hidden");
  setTimeout(() => msgBox.classList.add("hidden"), 3000);
}

function getRoomDoc(roomId) {
  return doc(db, "artifacts", appId, "public", "data", "rooms", roomId);
}

/* ==========================================
           初始化與認證
           ========================================== */
async function initAuth() {
  try {
    if (typeof __initial_auth_token !== "undefined" && __initial_auth_token) {
      await signInWithCustomToken(auth, __initial_auth_token);
    } else {
      await signInAnonymously(auth);
    }
  } catch (error) {
    console.error("登入失敗:", error);
    showMsg("連線失敗，請檢查網路或 Firebase 設定。");
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    myUid = user.uid;
  }
});

initAuth();

/* ==========================================
           STREAMING_CHUNK: 處理首頁使用者登入與房間初始化事件...
           ========================================== */
UI.home.btnEnter.onclick = async () => {
  const enteredName = UI.home.name.value.trim();
  if (!enteredName) {
    showMsg("請先輸入你的暱稱！");
    return;
  }
  if (!myUid) {
    showMsg("正在連線中，請稍候...");
    return;
  }

  UI.home.btnEnter.disabled = true;
  UI.home.btnEnter.textContent = "連線確認中...";

  try {
    const roomRef = getRoomDoc(GLOBAL_ROOM_ID);
    const roomSnap = await getDoc(roomRef);

    let finalName = enteredName;

    if (roomSnap.exists()) {
      const data = roomSnap.data();

      // 防中途加入限制
      if (data.status === "playing") {
        if (!data.players || !data.players[myUid]) {
          showMsg("🚫 遊戲正在進行中，無法中途加入！請稍候再試。");
          UI.home.btnEnter.disabled = false;
          UI.home.btnEnter.textContent = "進入遊戲";
          return;
        }
      }

      // 重名檢索機制
      const existingNames = Object.values(data.players || {}).map(
        (p) => p.name,
      );
      if (
        existingNames.includes(finalName) &&
        (!data.players || !data.players[myUid])
      ) {
        let counter = 1;
        while (existingNames.includes(`${enteredName} (${counter})`)) {
          counter++;
        }
        finalName = `${enteredName} (${counter})`;
        showMsg(`發現重複暱稱，已為你更名為: ${finalName}`);
      }

      myName = finalName;
      isHost = data.host === myUid;

      const newPlayers = { ...data.players };
      if (!newPlayers[myUid]) {
        newPlayers[myUid] = { name: myName, score: 0 };
        await updateDoc(roomRef, { players: newPlayers });
      } else {
        myName = newPlayers[myUid].name;
      }

      listenToRoom(GLOBAL_ROOM_ID);
      showScreen(data.status === "playing" ? "game" : "lobby");
    } else {
      myName = finalName;
      isHost = true;
      const roomData = {
        roomId: GLOBAL_ROOM_ID,
        host: myUid,
        status: "lobby",
        phase: "waiting",
        words: gameWords,
        currentWordIndex: 0,
        players: {
          [myUid]: { name: myName, score: 0 },
        },
        roundWinner: null,
        failedWords: [],
      };
      await setDoc(roomRef, roomData);
      listenToRoom(GLOBAL_ROOM_ID);
      showScreen("lobby");
    }
  } catch (err) {
    console.error("加入房間失敗:", err);
    showMsg("進入遊戲失敗！");
    UI.home.btnEnter.disabled = false;
    UI.home.btnEnter.textContent = "進入遊戲";
  }
};

// 一鍵安全清空資料庫
UI.home.btnForceReset.onclick = async () => {
  if (!confirm("確定要強制初始化資料庫嗎？這將會中斷所有正在進行的玩家。"))
    return;
  try {
    const roomRef = getRoomDoc(GLOBAL_ROOM_ID);
    await deleteDoc(roomRef);
    showMsg("✅ 資料庫已完全重置！你可以重新進入。");
  } catch (err) {
    console.error("強制重置失敗:", err);
    showMsg("重置失敗，請再試一次。");
  }
};

/* ==========================================
           STREAMING_CHUNK: 建立資料庫即時監聽與狀態分發器...
           ========================================== */
function listenToRoom(roomId) {
  if (roomUnsubscribe) roomUnsubscribe();

  roomUnsubscribe = onSnapshot(
    getRoomDoc(roomId),
    async (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        localRoomState = data;

        // 房主斷線自動轉移
        const playerIds = Object.keys(data.players || {});
        if (playerIds.length > 0 && !data.players[data.host]) {
          const newHost = playerIds[0];
          console.log(`房主斷線，由 ${data.players[newHost].name} 繼承權限`);
          try {
            await updateDoc(getRoomDoc(roomId), { host: newHost });
          } catch (e) {
            console.error("房主權限轉移失敗:", e);
          }
          return;
        }

        handleStateChange(data);
      } else {
        showScreen("home");
        UI.home.btnEnter.disabled = false;
        UI.home.btnEnter.textContent = "進入遊戲";
        showMsg("房間已被管理員重置。");
      }
    },
    (error) => {
      console.error("即時監聽出錯:", error);
    },
  );
}

function handleStateChange(state) {
  isHost = state.host === myUid;

  if (isHost) {
    document.getElementById("host-badge").classList.remove("hidden");
  } else {
    document.getElementById("host-badge").classList.add("hidden");
  }

  if (state.status === "lobby") {
    updateLobbyUI(state);
  } else if (state.status === "playing") {
    if (
      UI.screens.lobby.classList.contains("hidden-screen") === false ||
      UI.screens.home.classList.contains("hidden-screen") === false
    ) {
      showScreen("game");
    }
    updateGameUI(state);
  } else if (state.status === "finished") {
    showScreen("finished");
    updateFinishedUI(state);
  }
}

/* ==========================================
           各狀態畫面更新與定時器邏輯
           ========================================== */

// 1. 大廳 UI
function updateLobbyUI(state) {
  if (answerTimerInterval) {
    clearInterval(answerTimerInterval);
    answerTimerInterval = null;
  }
  if (nextRoundTimeoutId) {
    clearTimeout(nextRoundTimeoutId);
    nextRoundTimeoutId = null;
  }
  window.roundTimer = null;

  const playerIds = Object.keys(state.players);
  UI.lobby.playerCount.textContent = playerIds.length;

  UI.lobby.playerList.innerHTML = "";
  playerIds.forEach((uid) => {
    const p = state.players[uid];
    const li = document.createElement("li");
    li.className = `p-3 rounded-lg flex justify-between items-center ${uid === state.host ? "bg-yellow-50 border border-yellow-200 font-bold" : "bg-gray-50 border border-gray-100"}`;

    let identityText = "";
    if (uid === state.host) identityText += " 👑 房主";
    if (uid === myUid) identityText += " (你)";

    li.innerHTML = `
                    <span>👤 ${p.name}</span>
                    <span class="text-xs text-gray-400 font-normal">${identityText}</span>
                `;
    UI.lobby.playerList.appendChild(li);
  });

  if (isHost) {
    UI.lobby.btnStart.classList.remove("hidden");
    UI.lobby.waitMsg.classList.add("hidden");
  } else {
    UI.lobby.btnStart.classList.add("hidden");
    UI.lobby.waitMsg.classList.remove("hidden");
  }
}

UI.lobby.btnStart.onclick = async () => {
  if (isHost && localRoomState) {
    await updateDoc(getRoomDoc(currentRoomId), {
      status: "playing",
      phase: "reading",
      currentWordIndex: 0,
      failedWords: [],
    });
  }
};

/* ==========================================
           STREAMING_CHUNK: 管理搶答倒數與遊戲主畫面渲染...
           ========================================== */
function updateGameUI(state) {
  updateScoreboard(state);

  const currentWord = state.words[state.currentWordIndex];
  UI.game.currentRound.textContent = state.currentWordIndex + 1;

  if (state.phase !== "answering") {
    if (answerTimerInterval) {
      clearInterval(answerTimerInterval);
      answerTimerInterval = null;
    }
    document.getElementById("countdown-wrapper").classList.add("hidden");
  }

  // A. 聽單字階段
  if (state.phase === "reading") {
    UI.game.statusText.textContent = "🔊 準備聽單字...";
    UI.game.statusText.className = "text-xl font-bold text-blue-600";
    UI.game.chineseWord.textContent = currentWord.zh;

    UI.game.answerSection.classList.add("hidden");
    UI.game.roundResultSection.classList.add("hidden");
    UI.game.inputAnswer.value = "";

    if (!hasSpokenThisRound) {
      hasSpokenThisRound = true;
      if (isHost) {
        speakWord(currentWord.en, 3, async () => {
          await updateDoc(getRoomDoc(currentRoomId), { phase: "answering" });
        });
      }
    }
  }
  // B. 拼字搶答階段
  else if (state.phase === "answering") {
    hasSpokenThisRound = false;
    UI.game.statusText.textContent = "⌨️ 快點拼寫出英文單字！";
    UI.game.statusText.className =
      "text-xl font-bold text-red-500 animate-pulse";
    UI.game.chineseWord.textContent = currentWord.zh;

    UI.game.answerSection.classList.remove("hidden");
    UI.game.roundResultSection.classList.add("hidden");
    UI.game.inputAnswer.focus();

    // 10 秒倒數計時
    if (!answerTimerInterval) {
      let timeLeft = 15;
      const countdownWrapper = document.getElementById("countdown-wrapper");
      const countdownText = document.getElementById("countdown-text");

      countdownWrapper.classList.remove("hidden");
      countdownText.textContent = timeLeft;

      answerTimerInterval = setInterval(async () => {
        timeLeft--;
        countdownText.textContent = timeLeft;

        if (timeLeft <= 0) {
          clearInterval(answerTimerInterval);
          answerTimerInterval = null;
          countdownWrapper.classList.add("hidden");

          if (isHost) {
            try {
              // 將這個沒人答對的字加入失敗庫
              const updatedFailedWords = localRoomState.failedWords || [];
              updatedFailedWords.push(currentWord);

              await updateDoc(getRoomDoc(currentRoomId), {
                phase: "round_end",
                roundWinner: "timeout",
                failedWords: updatedFailedWords,
              });
            } catch (err) {
              console.error("超時寫入出錯:", err);
            }
          }
        }
      }, 1000);
    }
  }
  // C. 回合結束 (霸屏顯示，5秒自動前往下一題)
  else if (state.phase === "round_end") {
    hasSpokenThisRound = false;
    UI.game.statusText.textContent = "⏳ 回合結束，準備下一題";
    UI.game.statusText.className = "text-xl font-bold text-gray-500";

    UI.game.answerSection.classList.add("hidden");
    UI.game.roundResultSection.classList.remove("hidden");

    const resultTitle = document.getElementById("round-result-winner-title");
    const winnerContainer = document.getElementById("round-winner-container");

    if (state.roundWinner === "timeout") {
      resultTitle.textContent = "⏰ 答題超時！無人拼對";
      resultTitle.className = "text-4xl font-bold text-red-500 mb-2 bounce";
      winnerContainer.classList.add("hidden");
    } else {
      resultTitle.textContent = "🎉 搶答成功！";
      resultTitle.className = "text-3xl font-bold text-green-600 mb-1 bounce";
      winnerContainer.classList.remove("hidden");
      const winnerName = state.players[state.roundWinner]?.name || "未知";
      UI.game.roundWinnerName.textContent = winnerName;
    }

    // 以全小寫形式顯示正確答案
    UI.game.correctAnswerText.textContent = currentWord.en;

    // 房主控制 5秒 後進入下一關
    if (isHost) {
      if (!nextRoundTimeoutId) {
        nextRoundTimeoutId = setTimeout(async () => {
          nextRoundTimeoutId = null;
          const nextIndex = state.currentWordIndex + 1;

          if (nextIndex >= state.words.length) {
            await updateDoc(getRoomDoc(currentRoomId), { status: "finished" });
          } else {
            await updateDoc(getRoomDoc(currentRoomId), {
              currentWordIndex: nextIndex,
              phase: "reading",
              roundWinner: null,
            });
          }
        }, 5000); // 展示 5 秒加深印象
      }
    }
  }
}

/* ==========================================
           STREAMING_CHUNK: 渲染計分板與動態橫向能量棒...
           ========================================== */
function updateScoreboard(state) {
  UI.game.scoreboard.innerHTML = "";
  const sortedPlayers = Object.entries(state.players).sort(
    (a, b) => b[1].score - a[1].score,
  );

  const totalWords =
    state.words && state.words.length > 0 ? state.words.length : 1;

  sortedPlayers.forEach(([uid, p], index) => {
    const li = document.createElement("li");
    li.className = `flex flex-col p-3 rounded-xl shadow-sm gap-1.5 transition-all duration-300 ${uid === myUid ? "bg-blue-50 border border-blue-200" : "bg-gray-50 border border-gray-100"}`;

    let medal = "";
    if (index === 0 && p.score > 0) medal = "🥇 ";
    else if (index === 1 && p.score > 0) medal = "🥈 ";
    else if (index === 2 && p.score > 0) medal = "🥉 ";

    const progress = Math.min((p.score / totalWords) * 100, 100);

    li.innerHTML = `
                    <div class="flex justify-between items-center w-full">
                        <span class="font-semibold text-gray-700">${medal}${p.name} ${uid === myUid ? "(你)" : ""}</span>
                        <span class="font-bold text-lg text-blue-600">${p.score} 分</span>
                    </div>
                    <div class="w-full bg-gray-200 h-2.5 rounded-full overflow-hidden">
                        <div class="bg-green-500 h-full rounded-full transition-all duration-500" style="width: ${progress}%"></div>
                    </div>
                `;
    UI.game.scoreboard.appendChild(li);
  });
}

/* ==========================================
           搶答提交邏輯 (全小寫處理)
           ========================================== */
UI.game.btnSubmit.onclick = submitAnswer;
UI.game.inputAnswer.addEventListener("keypress", function (e) {
  if (e.key === "Enter") submitAnswer();
});

async function submitAnswer() {
  if (!localRoomState || localRoomState.phase !== "answering") return;

  const myAnswer = UI.game.inputAnswer.value.trim().toLowerCase();
  const correctWord =
    localRoomState.words[localRoomState.currentWordIndex].en.toLowerCase();

  if (myAnswer === correctWord) {
    UI.game.btnSubmit.disabled = true;
    const newPlayers = { ...localRoomState.players };
    newPlayers[myUid].score += 1;

    try {
      await updateDoc(getRoomDoc(currentRoomId), {
        phase: "round_end",
        roundWinner: myUid,
        players: newPlayers,
      });
    } catch (err) {
      console.error("更新分數出錯:", err);
    } finally {
      UI.game.btnSubmit.disabled = false;
    }
  } else {
    UI.game.inputAnswer.value = "";
    UI.game.inputAnswer.classList.add("border-red-500");
    setTimeout(
      () => UI.game.inputAnswer.classList.remove("border-red-500"),
      300,
    );
  }
}

/* ==========================================
           STREAMING_CHUNK: 渲染結算畫面與統計不熟生詞機制...
           ========================================== */
function updateFinishedUI(state) {
  const sortedPlayers = Object.entries(state.players).sort(
    (a, b) => b[1].score - a[1].score,
  );

  if (sortedPlayers.length > 0) {
    UI.finished.winnerName.textContent = sortedPlayers[0][1].name;
    UI.finished.winnerScore.textContent = sortedPlayers[0][1].score;
  }

  // 統計生詞清單
  UI.finished.failedWordsList.innerHTML = "";
  const failedWords = state.failedWords || [];

  if (failedWords.length === 0) {
    const li = document.createElement("li");
    li.className = "text-green-600 list-none text-center font-bold";
    li.textContent = "🎉 太棒了！本次沒有任何不會答的生詞！";
    UI.finished.failedWordsList.appendChild(li);
  } else {
    failedWords.forEach((word) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="font-bold font-mono text-red-600 lowercase">${word.en}</span> - <span class="text-gray-600">${word.zh}</span>`;
      UI.finished.failedWordsList.appendChild(li);
    });
  }

  if (isHost) {
    UI.finished.btnRestartLobby.classList.remove("hidden");
    UI.finished.waitRestartMsg.classList.add("hidden");
  } else {
    UI.finished.btnRestartLobby.classList.add("hidden");
    UI.finished.waitRestartMsg.classList.remove("hidden");
  }
}

// 切換顯示不會回答的生詞
UI.finished.btnShowFailedWords.onclick = () => {
  UI.finished.failedWordsContainer.classList.toggle("hidden");
};

// 重新開局
UI.finished.btnRestartLobby.onclick = async () => {
  if (!localRoomState) return;

  UI.finished.btnRestartLobby.disabled = true;
  UI.finished.btnRestartLobby.textContent = "重置資料中...";

  try {
    const resetPlayers = {};
    Object.keys(localRoomState.players).forEach((uid) => {
      resetPlayers[uid] = {
        name: localRoomState.players[uid].name,
        score: 0,
      };
    });

    await updateDoc(getRoomDoc(GLOBAL_ROOM_ID), {
      status: "lobby",
      phase: "waiting",
      currentWordIndex: 0,
      roundWinner: null,
      players: resetPlayers,
      failedWords: [],
    });

    showMsg("✨ 遊戲數據已重置！全員已回大廳。");
  } catch (err) {
    console.error("重置大廳失敗:", err);
    showMsg("重置失敗，請再試一次。");
  } finally {
    UI.finished.btnRestartLobby.disabled = false;
    UI.finished.btnRestartLobby.textContent = "🎮 重置分數並回大廳 (重新開局)";
  }
};

/* ==========================================
           STREAMING_CHUNK: 設置 TTS 語音發音模組 (恢復流暢的單字串發音法)...
           ========================================== */
window.activeUtterances = [];

function speakWord(word, times, callback) {
  if (!("speechSynthesis" in window)) {
    console.warn("此設備不支援語音合成");
    if (callback) setTimeout(callback, 2000);
    return;
  }

  // 先完全取消先前的所有語音隊列
  window.speechSynthesis.cancel();

  // 🌟 1. 建立暖身延遲時間 (600 毫秒靜置載入時間)，給瀏覽器音效通道充足的暖機時間
  setTimeout(() => {
    // 🌟 2. 將多次發音組合為一個句子，利用標點符號製造自然且剛好約 1 秒的停頓
    // 這種方法在 iOS, Android 與各式手機瀏覽器中穩定度最高，發音最流暢，不卡頓不重疊！
    const textToSpeak = Array(times).fill(word).join(", . . . . ");

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.lang = "en-US";
    utterance.rate = 0.82; // 稍微放慢一點，發音更清晰好聽

    // 綁定全域，防止瀏覽器記憶體回收機制 (GC) 中途將其刪除
    window.activeUtterances = [utterance];

    let callbackFired = false;
    const triggerNext = () => {
      if (!callbackFired) {
        callbackFired = true;
        window.activeUtterances = []; // 發音完釋放
        if (callback) callback();
      }
    };

    utterance.onend = triggerNext;
    utterance.onerror = triggerNext;

    // 備用安全超時防卡死護欄
    const estimatedTime = times * 2000 + 1500;
    setTimeout(triggerNext, estimatedTime);

    window.speechSynthesis.speak(utterance);
  }, 600); // 600ms 靜置，確保晶片與通道重置完畢，不吃音
}
