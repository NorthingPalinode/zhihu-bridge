import { clearZhihuCredential, importZhihuCredential, zhihuCredentialStatus, type ZhihuCredentialStatus } from "./lib/api";

export interface ZhihuCredentialsHandle {
  refresh(): Promise<void>;
  openDialog(): void;
  getMode(): ZhihuCredentialStatus["mode"];
}

export function mountZhihuCredentials(): ZhihuCredentialsHandle {
  const dialog = document.createElement("dialog");
  dialog.className = "zhihu-credential-dialog";
  dialog.setAttribute("aria-labelledby", "zhihuCredentialDialogTitle");
  dialog.innerHTML = '<form><h2 id="zhihuCredentialDialogTitle">导入知乎 Access Secret</h2>' +
    '<p>仅用于这个浏览器会话中的知乎开放平台接口调用，最长有效 8 小时。' +
    '<a href="https://developer.zhihu.com/profile" target="_blank" rel="noopener noreferrer">获取 Access Secret ↗</a></p>' +
    '<label for="zhihuAccessSecret">Access Secret</label>' +
    '<input id="zhihuAccessSecret" type="password" required maxlength="256" autocomplete="off" spellcheck="false" autofocus>' +
    '<p class="credential-error" role="alert"></p><div class="modal-foot">' +
    '<button type="button" class="link-btn" id="clearZhihuCredential" hidden>切回共享额度</button>' +
    '<button type="button" class="btn btn-ghost" id="cancelZhihuCredential">取消</button>' +
    '<button type="submit" class="btn btn-primary">校验并使用</button></div></form>';
  document.body.append(dialog);

  let requestId = 0;
  let updating = false;
  let currentMode: ZhihuCredentialStatus["mode"] = "shared";
  const clear = dialog.querySelector<HTMLButtonElement>("#clearZhihuCredential")!;
  const input = dialog.querySelector<HTMLInputElement>("#zhihuAccessSecret")!;
  const submit = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const error = dialog.querySelector<HTMLElement>(".credential-error")!;
  const cancel = dialog.querySelector<HTMLButtonElement>("#cancelZhihuCredential")!;

  function render(credential: ZhihuCredentialStatus) {
    currentMode = credential.mode;
    dialog.querySelector("h2")!.textContent = currentMode === "personal" ? "管理知乎 Access Secret" : "导入知乎 Access Secret";
    clear.hidden = credential.mode === "shared";
  }

  async function refresh() {
    if (updating) return;
    const id = ++requestId;
    try {
      const credential = await zhihuCredentialStatus();
      if (requestId === id) render(credential);
    } catch {
      // Keep the last known mode if a status request fails.
    }
  }

  const openDialog = () => { if (!updating) dialog.showModal(); };
  cancel.onclick = () => dialog.close();
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  dialog.addEventListener("cancel", (event) => { if (updating) event.preventDefault(); });
  dialog.addEventListener("close", () => { input.value = ""; error.textContent = ""; });
  dialog.querySelector("form")!.onsubmit = async (event) => {
    event.preventDefault();
    if (updating) return;
    updating = true;
    ++requestId;
    submit.disabled = cancel.disabled = clear.disabled = true;
    error.textContent = "";
    const secret = input.value.trim();
    input.value = "";
    try {
      render(await importZhihuCredential(secret));
      dialog.close();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : "校验失败，请重试。";
      input.focus();
    } finally {
      updating = false;
      submit.disabled = cancel.disabled = clear.disabled = false;
    }
  };
  clear.onclick = async () => {
    if (updating) return;
    updating = true;
    ++requestId;
    submit.disabled = cancel.disabled = clear.disabled = true;
    error.textContent = "";
    try {
      render(await clearZhihuCredential());
      dialog.close();
    } catch {
      error.textContent = "切换未完成，请重试。";
    } finally {
      updating = false;
      submit.disabled = cancel.disabled = clear.disabled = false;
    }
  };
  void refresh();
  return { refresh, openDialog, getMode: () => currentMode };
}
