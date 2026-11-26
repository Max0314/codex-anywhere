document.getElementById("approve").addEventListener("click", async function () {
  this.disabled = true;
  const status = document.getElementById("status");
  try {
    const access = await fetch("/api/access", { cache: "no-store" }).then((r) =>
      r.json(),
    );
    const response = await fetch(
      "/api/pc/intents/" + this.dataset.intent + "/approve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csrf: access.csrf }),
      },
    );
    const result = await response.json();
    if (response.status === 401) {
      location.assign("/_fribench/auth/login?return_to=" + encodeURIComponent(location.pathname + location.search));
      return;
    }
    if (!response.ok) throw Error(result.error || "unavailable");
    location.assign(result.redirect);
  } catch (error) {
    status.textContent = error.message === "intent_expired" ? "本次连接已过期，请回到电脑客户端重新登录。" : "连接暂未完成，请重试。";
    this.disabled = false;
  }
});
