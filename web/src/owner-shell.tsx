import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function OwnerShell({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<
    "loading" | "ready" | "login" | "denied" | "error"
  >("loading");
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
    try {
      const r = await fetch("/api/access", { cache: "no-store" });
      setAccess(
        r.ok
          ? "ready"
          : r.status === 401
            ? "login"
            : r.status === 403
              ? "denied"
              : "error",
      );
    } catch {
      setAccess("error");
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
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#171717" : "#fafafa");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  async function listDevices() {
    const response = await fetch("/api/devices", { cache: "no-store" });
    if (response.ok) setDevices(await response.json());
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
          <section className="login-card">
            <h1>Codex Anywhere</h1>
            <p>
              {access === "loading"
                ? "正在识别登录状态…"
                : access === "denied"
                  ? "此账号无权访问，请切换 Fribench 账号。"
                  : access === "error"
                    ? "登录服务暂时不可用，请重试。"
                    : "登录 Fribench，连接你的电脑。"}
            </p>
            <a
              className="pair-device-button"
              href="/_fribench/auth/login?return_to=%2F"
            >
              登录 Fribench
            </a>
            <p>
              <a href="/download">下载 Windows 客户端</a>
            </p>
            {access === "error" && <button onClick={check}>重试</button>}
          </section>
        </main>
      )}
      {access === "ready" &&
        toolbarTarget &&
        createPortal(
          <nav className="owner-tools" aria-label="账号与客户端">
            <a href="/download">下载 Windows 客户端</a>
            <button onClick={() => void listDevices()}>设备</button>
            <select
              aria-label="外观"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
            <a href="/_fribench/auth/manage?return_to=%2F">账号</a>
          </nav>,
          toolbarTarget,
        )}
      {devices && (
        <div className="dialog-backdrop">
          <section className="owner-device-dialog">
            <h2>设备</h2>
            {devices.map((d) => (
              <div key={d.role + d.id}>
                <span>
                  {d.label} · {d.role === "connector" ? "电脑" : "浏览器"}
                </span>
                <button
                  disabled={d.revoked}
                  onClick={() => void revoke(d.role, d.id)}
                >
                  {d.revoked ? "已撤销" : "撤销"}
                </button>
              </div>
            ))}
            <button onClick={() => setDevices(null)}>关闭</button>
          </section>
        </div>
      )}
    </>
  );
}
