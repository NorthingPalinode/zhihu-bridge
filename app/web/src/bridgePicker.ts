export interface PickerOption {
  value: string;
  label: string;
  sublabel?: string;
  badge?: string;
  description?: string;
  rtl?: boolean;
}

export interface BridgePickerConfig {
  id: string;
  ariaLabel: string;
  variant: "card" | "compact";
  layout: "grid" | "list";
  icon: "globe" | "users";
  kicker: string;
  popoverTitle: string;
  popoverHint?: string;
  align?: "left" | "right";
  triggerClass?: string;
  title?: string;
  onChange?: (value: string) => void;
}

export interface BridgePicker {
  readonly element: HTMLButtonElement;
  readonly value: string;
  getValue(): string;
  setValue(value: string): void;
  setOptions(options: PickerOption[], selectedValue?: string): void;
  setHint(hint: string): void;
  close(): void;
  destroy(): void;
}

const ICONS: Record<"globe" | "users", string> = {
  globe:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="10" cy="10" r="7.5"/>' +
    '<path d="M2.8 10h14.4M10 2.5c2.2 2.2 3.3 4.8 3.3 7.5s-1.1 5.3-3.3 7.5M10 2.5C7.8 4.7 6.7 7.3 6.7 10s1.1 5.3 3.3 7.5"/>' +
    "</svg>",
  users:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="7.5" cy="7" r="2.8"/>' +
    '<path d="M2.6 16.2c.4-2.5 2.4-4 4.9-4s4.5 1.5 4.9 4"/>' +
    '<path d="M13.3 4.8a2.4 2.4 0 0 1 0 4.4M14.4 12.4c1.6.4 2.8 1.6 3.1 3.8"/>' +
    "</svg>",
};

const CHEVRON_SVG =
  '<svg class="zb-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4.2 6.2 8 10l3.8-3.8"/>' +
  "</svg>";

const CHECK_SVG =
  '<svg class="zb-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3.5 8.5 6.6 11.5 12.5 4.8"/>' +
  "</svg>";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let activeCloser: (() => void) | null = null;

export function closeAnyBridgePicker() {
  activeCloser?.();
}

export function isBridgePickerOpen() {
  return activeCloser !== null;
}

export function createBridgePicker(config: BridgePickerConfig): BridgePicker {
  let options: PickerOption[] = [];
  let currentValue = "";
  let popoverHint = config.popoverHint ?? "";
  let open = false;
  let focusedIndex = -1;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = config.id;
  btn.className = [
    "zb-trigger",
    config.variant === "card" ? "zb-trigger-card" : "zb-trigger-compact",
    config.triggerClass ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-label", config.ariaLabel);
  if (config.title) btn.title = config.title;

  const popover = document.createElement("div");
  popover.className = "zb-popover zb-popover-" + config.layout;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", config.popoverTitle);
  popover.hidden = true;

  const listboxId = config.id + "-listbox";

  function currentOption(): PickerOption | undefined {
    return options.find((o) => o.value === currentValue) ?? options[0];
  }

  function renderTrigger() {
    const opt = currentOption();
    const label = opt?.label ?? "请选择";
    const sub = opt?.sublabel ?? "";
    const metaChip = opt?.badge ?? "";
    const marketOrDesc = config.layout === "grid" ? (opt?.description ?? "") : "";

    if (config.variant === "card") {
      btn.innerHTML =
        '<span class="zb-ic">' + ICONS[config.icon] + "</span>" +
        '<span class="zb-body">' +
          '<span class="zb-kicker-row">' +
            '<span class="zb-kicker">' + esc(config.kicker) + "</span>" +
            (marketOrDesc
              ? '<span class="zb-kicker-sub">' + esc(marketOrDesc) + "</span>"
              : (metaChip ? '<span class="zb-kicker-pill">' + esc(metaChip) + "</span>" : "")) +
          "</span>" +
          '<span class="zb-val-row">' +
            '<span class="zb-val">' + esc(label) + "</span>" +
            (sub ? '<span class="zb-sub"' + (opt?.rtl ? ' dir="rtl"' : "") + ">" + esc(sub) + "</span>" : "") +
            (opt?.rtl ? '<span class="zb-rtl">RTL</span>' : "") +
          "</span>" +
        "</span>" +
        CHEVRON_SVG;
    } else {
      btn.innerHTML =
        '<span class="zb-ic-sm">' + ICONS[config.icon] + "</span>" +
        '<span class="zb-compact-val">' +
          esc(label) +
          (sub ? '<span class="zb-compact-sub"> · ' + esc(sub) + "</span>" : "") +
        "</span>" +
        CHEVRON_SVG;
    }
  }

  function renderPopover() {
    const hintText = popoverHint || (config.layout === "grid" ? options.length + " 种主流语言" : "");
    const header =
      '<div class="zb-pop-head">' +
        '<span class="zb-pop-title">' + esc(config.popoverTitle) + "</span>" +
        (hintText ? '<span class="zb-pop-hint">' + esc(hintText) + "</span>" : "") +
      "</div>";

    const items = options
      .map((opt, idx) => {
        const selected = opt.value === currentValue;
        const badgeHtml = opt.badge
          ? '<span class="zb-opt-badge">' + esc(opt.badge) + "</span>"
          : "";
        const rtlHtml = opt.rtl ? '<span class="zb-rtl">RTL</span>' : "";
        const subHtml = opt.sublabel
          ? '<span class="zb-opt-sub"' + (opt.rtl ? ' dir="rtl"' : "") + ">" + esc(opt.sublabel) + "</span>"
          : "";
        const descHtml = opt.description
          ? '<span class="zb-opt-desc">' + esc(opt.description) + "</span>"
          : "";
        return (
          '<button type="button" class="zb-opt' + (selected ? " is-selected" : "") + '" ' +
            'role="option" aria-selected="' + String(selected) + '" ' +
            'data-zb-idx="' + idx + '" data-zb-val="' + esc(opt.value) + '">' +
            '<span class="zb-opt-main">' +
              '<span class="zb-opt-top">' +
                '<span class="zb-opt-title">' + esc(opt.label) + "</span>" +
                subHtml +
                badgeHtml +
                rtlHtml +
              "</span>" +
              descHtml +
            "</span>" +
            '<span class="zb-opt-check">' + (selected ? CHECK_SVG : "") + "</span>" +
          "</button>"
        );
      })
      .join("");

    popover.innerHTML =
      header +
      '<div class="zb-pop-list zb-pop-' + config.layout + '" id="' + esc(listboxId) + '" role="listbox" aria-label="' + esc(config.ariaLabel) + '">' +
        items +
      "</div>";
  }

  function positionPopover() {
    const rect = btn.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    popover.style.maxHeight = "";
    popover.style.top = "0px";
    popover.style.left = "0px";
    const popRect = popover.getBoundingClientRect();

    let left = config.align === "right" ? rect.right - popRect.width : rect.left;
    if (left + popRect.width > vw - margin) {
      left = Math.max(margin, rect.right - popRect.width);
    }
    if (left < margin) left = margin;
    popover.classList.toggle("is-right", config.align === "right");

    const spaceBelow = vh - rect.bottom - margin - gap;
    const spaceAbove = rect.top - margin - gap;
    const openUp = popRect.height > spaceBelow && spaceAbove > spaceBelow;

    popover.classList.toggle("is-up", openUp);

    let top: number;
    let maxH: number;
    if (openUp) {
      maxH = Math.max(180, spaceAbove);
      const actualH = Math.min(popRect.height, maxH);
      top = Math.max(margin, rect.top - gap - actualH);
    } else {
      maxH = Math.max(180, spaceBelow);
      top = rect.bottom + gap;
    }

    popover.style.left = Math.round(left) + "px";
    popover.style.top = Math.round(top) + "px";
    popover.style.maxHeight = Math.floor(maxH) + "px";
  }

  function focusOption(index: number) {
    if (!options.length) return;
    focusedIndex = ((index % options.length) + options.length) % options.length;
    const nodes = popover.querySelectorAll<HTMLButtonElement>(".zb-opt");
    nodes.forEach((n, i) => n.classList.toggle("is-focus", i === focusedIndex));
    const target = nodes[focusedIndex];
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    }
  }

  function selectValue(val: string, emit: boolean) {
    if (!options.some((o) => o.value === val)) return;
    const changed = currentValue !== val;
    currentValue = val;
    renderTrigger();
    if (open) close(true);
    if (emit && changed) config.onChange?.(val);
  }

  function onDocPointerDown(e: MouseEvent) {
    const t = e.target as Node | null;
    if (!t) return;
    if (btn.contains(t) || popover.contains(t)) return;
    close(false);
  }

  function onDocKeyDown(e: KeyboardEvent) {
    if (!open) return;
    const cols = config.layout === "grid" && window.innerWidth >= 560 ? 2 : 1;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      focusOption(focusedIndex < 0 ? 0 : focusedIndex + cols);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      focusOption(focusedIndex < 0 ? options.length - 1 : focusedIndex - cols);
      return;
    }
    if (cols > 1 && e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      focusOption(focusedIndex < 0 ? 0 : focusedIndex + 1);
      return;
    }
    if (cols > 1 && e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      focusOption(focusedIndex < 0 ? options.length - 1 : focusedIndex - 1);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      focusOption(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      focusOption(options.length - 1);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
      e.stopPropagation();
    }
  }

  function onWindowRelayout(e?: Event) {
    if (e?.target instanceof Node && popover.contains(e.target)) return;
    if (open) positionPopover();
  }

  function openPopover() {
    if (open || !options.length) return;
    if (activeCloser) activeCloser();
    open = true;
    renderPopover();
    if (!popover.isConnected) document.body.appendChild(popover);
    popover.hidden = false;
    popover.classList.remove("is-open");
    positionPopover();
    void popover.offsetWidth;
    popover.classList.add("is-open");
    btn.classList.add("is-open");
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-controls", listboxId);

    const selIdx = Math.max(0, options.findIndex((o) => o.value === currentValue));
    focusedIndex = selIdx;
    const selectedEl = popover.querySelector<HTMLButtonElement>('[data-zb-idx="' + selIdx + '"]');
    selectedEl?.scrollIntoView({ block: "nearest" });

    activeCloser = () => close(false);
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    window.addEventListener("resize", onWindowRelayout);
    window.addEventListener("scroll", onWindowRelayout, true);
  }

  function close(restoreFocus = false) {
    if (!open) return;
    open = false;
    popover.classList.remove("is-open");
    popover.hidden = true;
    btn.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
    btn.removeAttribute("aria-controls");
    document.removeEventListener("mousedown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    window.removeEventListener("resize", onWindowRelayout);
    window.removeEventListener("scroll", onWindowRelayout, true);
    if (activeCloser) activeCloser = null;
    if (restoreFocus) btn.focus();
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (open) close(false);
    else openPopover();
  });

  btn.addEventListener("keydown", (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      e.stopPropagation();
      openPopover();
      focusOption(Math.max(0, options.findIndex((o) => o.value === currentValue)));
    }
  });

  popover.addEventListener("click", (e) => {
    const optBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".zb-opt");
    if (!optBtn) return;
    e.stopPropagation();
    const val = optBtn.dataset.zbVal;
    if (val !== undefined) selectValue(val, true);
  });

  renderTrigger();

  return {
    get element() {
      return btn;
    },
    get value() {
      return currentValue;
    },
    getValue() {
      return currentValue;
    },
    setValue(val: string) {
      if (options.some((o) => o.value === val)) {
        currentValue = val;
        renderTrigger();
        if (open) renderPopover();
      }
    },
    setOptions(nextOptions: PickerOption[], selectedValue?: string) {
      options = nextOptions;
      if (selectedValue !== undefined && options.some((o) => o.value === selectedValue)) {
        currentValue = selectedValue;
      } else if (!options.some((o) => o.value === currentValue)) {
        currentValue = options[0]?.value ?? "";
      }
      renderTrigger();
      if (open) {
        renderPopover();
        positionPopover();
      }
    },
    setHint(hint: string) {
      popoverHint = hint;
      if (open) renderPopover();
    },
    close() {
      close(false);
    },
    destroy() {
      close(false);
      popover.remove();
    },
  };
}
