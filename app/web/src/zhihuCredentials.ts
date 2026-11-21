import { clearZhihuCredential, importZhihuCredential, zhihuCredentialStatus, type ZhihuCredentialStatus } from "./lib/api";

export function mountZhihuCredentials() {
  const section = document.createElement("section");
  section.className = "zhihu-credentials";
  section.setAttribute("aria-labelledby", "zhihuCredentialsTitle");
  section.innerHTML = '<div><h2 id="zhihuCredentialsTitle">知乎 Access Secret</h2>' +
    '<p>项目创作者提供的共享额度有限。用完后可导入自己的 Access Secret，继续使用知乎检索和问题发现。</p>' +
    '<p class="quota-status" role="status" hidden></p></div>' +
    '<div class="credential-actions"><button type="button" class="btn btn-ghost" id="openZhihuCredential">导入个人密钥</button>' +
    '<button type="button" class="link-btn" id="clearZhihuCredential" hidden>切回共享额度</button></div>';
  document.getElementById("hero")!.append(section);

  const dialog = document.createElement("dialog");
  dialog.className = "zhihu-credential-dialog";
  dialog.setAttribute("aria-labelledby", "zhihuCredentialDialogTitle");
  dialog.innerHTML = '<form><h2 id="zhihuCredentialDialogTitle">导入知乎 Access Secret</h2>' +
    '<p>仅用于这个浏览器会话中的知乎检索与问题发现，最长有效 8 小时。' +
    '<a href="https://developer.zhihu.com/profile" target="_blank" rel="noopener noreferrer">获取 Access Secret ↗</a></p>' +
    '<label for="zhihuAccessSecret">Access Secret</label>' +
    '<input id="zhihuAccessSecret" type="password" required maxlength="256" autocomplete="off" spellcheck="false" autofocus>' +
    '<p class="credential-error" role="alert"></p><div class="modal-foot">' +
    '<button type="button" class="btn btn-ghost" id="cancelZhihuCredential">取消</button>' +
    '<button type="submit" class="btn btn-primary">校验并使用</button></div></form>';
  document.body.append(dialog);

  let requestId = 0;
  let updating = false;
  const status = section.querySelector<HTMLElement>(".quota-status")!;
  const toggle = section.querySelector<HTMLButtonElement>("#openZhihuCredential")!;
  const clear = section.querySelector<HTMLButtonElement>("#clearZhihuCredential")!;
  const input = dialog.querySelector<HTMLInputElement>("#zhihuAccessSecret")!;
  const submit = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const error = dialog.querySelector<HTMLElement>(".credential-error")!;

  function quotaText(quotas: Record<string, number>) {
    return [["zhihu_search", "检索"], ["question_discovery", "问题发现"]].flatMap(([id, label]) =>
      typeof quotas[id] === "number" ? [label + "余 " + quotas[id] + " 次"] : []).join(" · ");
  }

  function setStatus(text: string) {
    status.textContent = text;
    status.hidden = !text;
  }

  function render(credential: ZhihuCredentialStatus) {
    switch (credential.mode) {
      case "personal": {
        const quota = quotaText(credential.personalQuotaAtImport ?? {});
        setStatus("当前使用个人知乎额度" + (quota ? " · 导入时" + quota : ""));
        break;
      }
      case "expired":
        setStatus("个人密钥会话已过期，请重新导入或切回共享额度。");
        break;
      default:
        setStatus(credential.sharedAvailable ? "" : "项目共享凭据暂不可用，可导入个人密钥。");
    }
    toggle.textContent = credential.mode === "personal" ? "更换个人密钥" : "导入个人密钥";
    clear.hidden = credential.mode === "shared";
  }

  async function refresh() {
    if (updating) return;
    const id = ++requestId;
    try {
      const credential = await zhihuCredentialStatus();
      if (requestId === id) render(credential);
    } catch {
      if (requestId === id) setStatus("");
    }
  }

  toggle.onclick = () => { if (!updating) dialog.showModal(); };
  dialog.querySelector<HTMLButtonElement>("#cancelZhihuCredential")!.onclick = () => dialog.close();
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  dialog.addEventListener("cancel", (event) => { if (updating) event.preventDefault(); });
  dialog.addEventListener("close", () => { input.value = ""; error.textContent = ""; });
  const cancel = dialog.querySelector<HTMLButtonElement>("#cancelZhihuCredential")!;
  dialog.querySelector("form")!.onsubmit = async (event) => {
    event.preventDefault();
    if (updating) return;
    updating = true;
    ++requestId;
    submit.disabled = cancel.disabled = true;
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
      submit.disabled = cancel.disabled = false;
    }
  };
  clear.onclick = async () => {
    if (updating) return;
    updating = clear.disabled = true;
    ++requestId;
    try {
      render(await clearZhihuCredential());
    } catch {
      setStatus("切换未完成，请重试。");
    } finally {
      updating = clear.disabled = false;
    }
  };
  void refresh();
  return { refresh };
}
