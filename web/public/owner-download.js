document
  .getElementById("download")
  .addEventListener("click", async function () {
    const status = document.getElementById("status");
    try {
      const response = await fetch("/api/releases/stable", {
        cache: "no-store",
      });
      if (response.status === 401) {
        location.assign("/_fribench/auth/login?return_to=%2Fdownload");
        return;
      }
      if (!response.ok) throw Error();
      const release = await response.json();
      status.textContent =
        release.version +
        " · " +
        Math.ceil(release.bytes / 1048576) +
        " MB · SHA-256 " +
        release.sha256;
      location.assign(release.path);
    } catch {
      status.textContent = "暂时无法下载，请稍后重试。";
    }
  });
