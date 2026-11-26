document.getElementById('approve').addEventListener('click', async function () {
  this.disabled = true;
  const status = document.getElementById('status');
  try {
    const access = await fetch('/api/access', { cache: 'no-store' }).then(r => r.json());
    const response = await fetch('/api/pc/intents/' + this.dataset.intent + '/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csrf: access.csrf }) });
    const result = await response.json();
    if (!response.ok) throw Error();
    location.assign(result.redirect);
  } catch { status.textContent = '连接未完成，请从电脑客户端重新发起。'; this.disabled = false; }
});
