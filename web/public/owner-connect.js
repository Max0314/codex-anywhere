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
        body: JSON.stringify({ csrf: access.csrf, accountKey: this.dataset.account }),
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
    const messages = {
      intent_expired: "本次连接已过期，请回到电脑客户端重新登录。",
      account_changed: "Fribench 账号已切换，请刷新页面并重新确认。",
      device_account_conflict: "这台电脑已绑定其他 Fribench 账号。",
      intent_already_approved: "此请求已确认，请回到电脑客户端查看连接状态。",
    };
    status.textContent = messages[error.message] || "连接暂未完成，请重试。";
    this.disabled = false;
  }
});
