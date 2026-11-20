// Popup UI: settings + progress. The job itself runs in background.js.

const $ = (id) => document.getElementById(id);

function readConfig() {
  const categories = [...document.querySelectorAll("#categories input:checked")].map(
    (el) => el.value
  );
  return {
    instance: $("instance").value.trim().replace(/\/+$/, "") || "https://neodb.social",
    token: $("token").value.trim(),
    categories,
    includeRating: $("includeRating").checked,
    includeComments: $("includeComments").checked,
    visibility: $("visibility").value,
    dryRun: $("dryRun").checked,
  };
}

function applyConfig(c) {
  if (!c) return;
  if (c.instance) $("instance").value = c.instance;
  if (c.token) $("token").value = c.token;
  if (Array.isArray(c.categories)) {
    document.querySelectorAll("#categories input").forEach((el) => {
      el.checked = c.categories.includes(el.value);
    });
  }
  if (typeof c.includeRating === "boolean") $("includeRating").checked = c.includeRating;
  if (typeof c.includeComments === "boolean")
    $("includeComments").checked = c.includeComments;
  if (c.visibility) $("visibility").value = c.visibility;
  if (typeof c.dryRun === "boolean") $("dryRun").checked = c.dryRun;
}

function render(state) {
  const running = ["scanning", "matching", "marking"].includes(state.status);
  $("startBtn").disabled = running;
  $("startBtn").textContent =
    state.status === "paused" ? "重新開始同步" : "開始同步";

  const parts = [];
  if (state.phase) parts.push(state.phase);
  if (state.current) parts.push(state.current);
  if (state.total)
    parts.push(
      `豆瓣 ${state.total} 條 · 已匹配 ${state.matched} · 已寫入 ${state.marked} · 失敗 ${state.failed}`
    );
  if (state.error) parts.push("⚠ " + state.error);
  $("status").textContent = parts.join("\n") || "未開始";

  const done = state.marked + state.failed;
  const total = state.total || 0;
  $("progressBar").style.width =
    total > 0 ? Math.round((done / total) * 100) + "%" : "0";

  $("log").textContent = (state.log || []).join("\n");
  $("log").scrollTop = $("log").scrollHeight;

  const r = state.report;
  if (r) {
    let html = "<h2>結果</h2><ul>";
    html += `<li>豆瓣共 ${r.total} 條</li>`;
    html += `<li>可同步 ${r.matched} 條</li>`;
    if (r.failed && r.failed.length) {
      html += `<li>失敗 ${r.failed.length} 條：</li>`;
      html += r.failed
        .slice(0, 10)
        .map((f) => `<li>「${escapeHtml(f.item.title)}」— ${escapeHtml(f.reason)}</li>`)
        .join("");
      if (r.failed.length > 10) html += `<li>……還有 ${r.failed.length - 10} 條</li>`;
    }
    if (r.sample) {
      html += "<li>示例（前 5 條將這樣寫入）：</li>";
      html += r.sample
        .map(
          (s) =>
            `<li>「${escapeHtml(s.title)}」— ${escapeHtml(s.date || "無日期")}${
              s.stars ? ` · ${s.stars} 星` : ""
            }${s.comment ? ` · “${escapeHtml(s.comment)}”` : ""}</li>`
        )
        .join("");
    }
    html += "</ul>";
    $("report").innerHTML = html;
  } else {
    $("report").innerHTML = "";
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

$("startBtn").addEventListener("click", async () => {
  const config = readConfig();
  if (!config.token) {
    alert("請先填寫 NeoDB API Token。");
    return;
  }
  if (config.categories.length === 0) {
    alert("請至少勾選一個分類。");
    return;
  }
  await send({ type: "saveConfig", config });
  const r = await send({ type: "start", config });
  if (r && r.error) alert(r.error);
  refresh();
});

$("pauseBtn").addEventListener("click", async () => {
  await send({ type: "pause" });
  refresh();
});

$("resetBtn").addEventListener("click", async () => {
  await send({ type: "reset" });
  refresh();
});

async function refresh() {
  const { state } = await send({ type: "getState" });
  if (state) render(state);
}

(async () => {
  const { config } = await send({ type: "getConfig" });
  applyConfig(config);
  await refresh();
  setInterval(refresh, 1000);
})();
