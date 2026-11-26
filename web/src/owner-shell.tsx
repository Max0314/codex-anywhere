import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BrandIcon } from './brand-icon';

function OwnerIcon({ name }: { name: "download" | "devices" | "account" | "system" | "light" | "dark" | "close" }) {
  const paths = {
    download: <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M5 15v5h14v-5" /></>,
    devices: <><rect x="3" y="4" width="14" height="11" rx="2" /><path d="M7 20h7m-4-5v5" /><rect x="17" y="11" width="5" height="10" rx="1" /></>,
    account: <><circle cx="12" cy="8" r="3" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
    system: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
    light: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" /></>,
    dark: <path d="M20.5 13.2A9 9 0 0 1 10.8 3.5a9 9 0 1 0 9.7 9.7Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export function OwnerShell({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<
    "loading" | "ready" | "login" | "denied" | "revoked" | "error"
  >("loading");
  const accessRef = useRef(access);
  const checks = useRef(0);
  const deviceRequests = useRef(0);
  const [devices, setDevices] = useState<any[] | null>(null);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (access !== "ready") return;
    const timer = setInterval(() => {
      const target = document.getElementById("owner-tools-slot");
      if (target) {
        setToolbarTarget(target);
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [access]);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("bridge.theme") || "system",
  );
  async function check() {
    const sequence = ++checks.current;
    const apply = (next: typeof access) => {
      if(sequence !== checks.current) return;
      accessRef.current = next;
      setAccess(next);
      if(next !== 'ready'){ deviceRequests.current++; setDevices(null); setToolbarTarget(null); }
    };
    try {
      const r = await fetch("/api/access", { cache: "no-store" });
      if(r.ok) apply('ready');
      else if(r.status === 401) apply('login');
      else if(r.status === 403){ const detail = await r.json().catch(() => ({})); apply(detail.error === 'device_revoked' ? 'revoked' : 'denied'); }
      else apply(accessRef.current === 'ready' ? 'ready' : 'error');
    } catch {
      apply(accessRef.current === 'ready' ? 'ready' : 'error');
    }
  }
  useEffect(() => {
    void check();
    const accountChange = () => void check();
    const timer = setInterval(accountChange, 10000);
    window.addEventListener("fribench:account-change", accountChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener("fribench:account-change", accountChange);
    };
  }, []);
  useEffect(() => {
    localStorage.setItem("bridge.theme", theme);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', dark ? 'dark' : 'light');
      document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content', dark ? 'black-translucent' : 'default');
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#212121" : "#ffffff");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  async function listDevices() {
    const sequence = ++deviceRequests.current;
    if(accessRef.current !== 'ready') return;
    const response = await fetch("/api/devices", { cache: "no-store" });
    if (response.ok) {
      const result = await response.json();
      if(sequence === deviceRequests.current && accessRef.current === 'ready') setDevices(result);
    }
  }
  async function revoke(role: string, id: string) {
    if (!confirm("撤销此设备的访问权限？")) return;
    const a = await fetch("/api/access", { cache: "no-store" }).then((r) =>
      r.json(),
    );
    const r = await fetch(`/api/devices/${role}/${id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csrf: a.csrf }),
    });
    if (r.ok) await listDevices();
  }
  return (
    <>
      {access === "ready" ? (
        children
      ) : (
        <main className="login-shell">
          <section className="login-card owner-login-card">
            <div className="owner-login-mark" aria-hidden="true"><BrandIcon /></div>
            <h1>Codex Anywhere</h1>
            <p>
              {access === "loading"
                ? "正在识别登录状态…"
                : access === "denied"
                  ? "此账号无权访问，请切换 Fribench 账号。"
                  : access === "revoked"
                    ? "此浏览器的访问权限已被撤销，请使用已授权设备检查设备管理。"
                  : access === "error"
                    ? "登录服务暂时不可用，请重试。"
                    : "登录 Fribench，连接你的电脑。"}
            </p>
            <a
              className="owner-login-button"
              href="/_fribench/auth/login?return_to=%2F"
            >
              登录 Fribench
            </a>
            <p>
              <a className="owner-download-link" href="/download"><OwnerIcon name="download" />下载 Windows 客户端</a>
            </p>
            {access === "error" && <button onClick={check}>重试</button>}
          </section>
        </main>
      )}
      {access === "ready" &&
        toolbarTarget &&
        createPortal(
          <nav className="owner-tools" aria-label="账号与客户端">
            <a className="owner-tool-row" href="/download"><OwnerIcon name="download" /><span>下载 Windows 客户端</span></a>
            <div className="owner-account-row">
              <a className="owner-tool-row" href="/_fribench/auth/manage?return_to=%2F"><OwnerIcon name="account" /><span>Fribench 账号</span></a>
              <button className="owner-devices-button" title="管理设备" aria-label="管理设备" onClick={() => void listDevices()}><OwnerIcon name="devices" /></button>
            </div>
            <div className="owner-appearance"><span>外观</span><div role="group" aria-label="外观">
              {(["system", "light", "dark"] as const).map((value) => <button key={value} title={{system: "跟随系统", light: "浅色", dark: "深色"}[value]} aria-label={{system: "跟随系统", light: "浅色", dark: "深色"}[value]} aria-pressed={theme === value} onClick={() => setTheme(value)}><OwnerIcon name={value} /></button>)}
            </div></div>
          </nav>,
          toolbarTarget,
        )}
      {access === 'ready' && devices && (
        <div className="owner-dialog-backdrop" onClick={() => setDevices(null)}>
          <section className="owner-device-dialog" role="dialog" aria-modal="true" aria-labelledby="owner-devices-title" onClick={(event) => event.stopPropagation()}>
            <header><div><h2 id="owner-devices-title">已连接的设备</h2><p>管理电脑和浏览器的访问权限</p></div><button aria-label="关闭" onClick={() => setDevices(null)}><OwnerIcon name="close" /></button></header>
            <div className="owner-device-list">
            {devices.map((d) => (
              <div className="owner-device-row" key={d.role + d.id}>
                <OwnerIcon name={d.role === "connector" ? "system" : "devices"} />
                <span>
                  <strong>{d.label}</strong><small>{d.role === "connector" ? "电脑" : "浏览器"}</small>
                </span>
                <button
                  disabled={d.revoked}
                  onClick={() => void revoke(d.role, d.id)}
                >
                  {d.revoked ? "已撤销" : "撤销"}
                </button>
              </div>
            ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
