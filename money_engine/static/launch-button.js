(function () {
  if (document.getElementById("me-launch-btn")) return;

  const style = document.createElement("style");
  style.textContent = `
    #me-launch-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      background: #22c55e; color: #052e16; border: none; border-radius: 50px;
      padding: 14px 22px; font-size: 15px; font-weight: 800; cursor: pointer;
      box-shadow: 0 4px 24px rgba(34,197,94,0.5);
      font-family: system-ui, sans-serif; display: flex; align-items: center; gap: 8px;
      transition: transform 0.15s, box-shadow 0.15s;
      text-decoration: none;
    }
    #me-launch-btn:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 32px rgba(34,197,94,0.6);
    }
    #me-launch-btn.running { background: #1e293b; color: #22c55e; border: 2px solid #22c55e; }
    #me-launch-panel {
      position: fixed; bottom: 80px; right: 24px; z-index: 99998;
      background: #1e293b; border: 1px solid #334155; border-radius: 12px;
      padding: 12px; display: none; flex-direction: column; gap: 6px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 180px;
      font-family: system-ui, sans-serif;
    }
    #me-launch-panel.open { display: flex; }
    #me-launch-panel a, #me-launch-panel button {
      background: #334155; color: #e2e8f0; border: none; border-radius: 8px;
      padding: 10px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
      text-decoration: none; text-align: left;
    }
    #me-launch-panel a:hover, #me-launch-panel button:hover { background: #475569; }
    #me-launch-panel .primary { background: #22c55e; color: #052e16; }
    #me-launch-panel .primary:hover { background: #16a34a; }
    @media (max-width: 480px) {
      #me-launch-btn { bottom: 16px; right: 16px; padding: 12px 18px; font-size: 14px; }
      #me-launch-panel { bottom: 68px; right: 16px; }
    }
  `;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "me-launch-panel";
  panel.innerHTML = `
    <button class="primary" id="me-btn-start">🚀 Запустить систему</button>
    <a href="/dashboard">📊 Дашборд</a>
    <a href="/hub/">🎮 Витрина</a>
    <a href="/">⚙️ Настройки</a>
  `;

  const btn = document.createElement("button");
  btn.id = "me-launch-btn";
  btn.innerHTML = "🚀 Запустить";
  btn.title = "Money Engine — управление системой";

  document.body.appendChild(panel);
  document.body.appendChild(btn);

  btn.addEventListener("click", () => {
    panel.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!btn.contains(e.target) && !panel.contains(e.target)) {
      panel.classList.remove("open");
    }
  });

  document.getElementById("me-btn-start").addEventListener("click", async () => {
    const startBtn = document.getElementById("me-btn-start");
    startBtn.textContent = "⏳ Запуск...";
    startBtn.disabled = true;
    try {
      const r = await fetch("/api/launch", { method: "POST" });
      const d = await r.json();
      startBtn.textContent = "✅ Запущено (" + d.active_projects + " проектов)";
      btn.innerHTML = "✅ Работает";
      btn.classList.add("running");
      setTimeout(() => panel.classList.remove("open"), 2000);
    } catch (e) {
      window.location.href = "/";
    } finally {
      startBtn.disabled = false;
    }
  });

  async function checkStatus() {
    try {
      const r = await fetch("/api/launch");
      const d = await r.json();
      if (d.ready) {
        btn.innerHTML = "✅ Работает";
        btn.classList.add("running");
        document.getElementById("me-btn-start").textContent =
          "✅ " + d.active_projects + " проектов · " + Math.round(d.projected_rub_per_day) + " ₽/день";
      }
    } catch (e) {}
  }

  checkStatus();
  setInterval(checkStatus, 30000);
})();
