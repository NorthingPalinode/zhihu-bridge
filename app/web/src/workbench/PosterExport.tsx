import { useEffect, useMemo, useRef, useState } from "react";
import { api, downloadBlob, downloadText } from "./api";
import { DEMO_TAG, hasStage } from "./copy";
import { useWb } from "./context";
import {
  FORMAT_META,
  THEME_META,
  buildLandingPageHtml,
  buildPosterSvg,
  buildSocialKit,
  extractPromoData,
  svgToPngBlob,
  type PosterFormat,
  type PosterTheme,
} from "./exportAssets";
import { Icon } from "./icons";
import type { ExportPack } from "./types";

type ExportTab = "poster" | "landing" | "social" | "docs";

export function ExportDrawer({ onClose, onDecide, onGoReview, initialTab = "poster" }: {
  onClose: () => void; onDecide: () => void; onGoReview: () => void; initialTab?: ExportTab;
}) {
  const { ws, toast } = useWb();
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const close = () => closeRef.current();
    d.addEventListener("close", close);
    return () => d.removeEventListener("close", close);
  }, []);

  const [tab, setTab] = useState<ExportTab>(initialTab);
  const [format, setFormat] = useState<PosterFormat>("portrait");
  const [theme, setTheme] = useState<PosterTheme>("nebula");
  const [rendering, setRendering] = useState(false);
  const [pack, setPack] = useState<ExportPack | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    api.exportPack(ws.id).then(setPack, () => toast("导出内容没有生成成功，请再试一次"));
  }, [ws.id, toast]);

  const promo = useMemo(() => extractPromoData(ws), [ws]);
  const posterSvg = useMemo(() => buildPosterSvg(promo, format, theme), [promo, format, theme]);
  const landingHtml = useMemo(() => buildLandingPageHtml(promo, theme), [promo, theme]);
  const socialPosts = useMemo(() => buildSocialKit(promo), [promo]);
  const slug = promo.shortBrand.replace(/[^a-zA-Z0-9-_]/g, "") || "zhihu-bridge";
  const reviewed = hasStage(ws, "review") && (pack ? pack.reviewed !== false : true);
  const draftSuffix = reviewed ? "" : "-draft";

  const copy = (key: string, text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => { setCopied(key); setTimeout(() => setCopied(null), 1600); },
      () => toast("浏览器不允许复制，请手动选择文字"),
    );

  const downloadPng = async () => {
    setRendering(true);
    try {
      const { w, h } = FORMAT_META[format];
      const blob = await svgToPngBlob(posterSvg, w, h);
      downloadBlob(`${slug}-poster-${format}-${theme}${draftSuffix}.png`, blob);
      toast(reviewed ? `已导出高清宣传海报 PNG（${w}×${h}）` : `已导出未审校初稿海报 PNG（${w}×${h}）`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "海报 PNG 导出失败，可尝试下载 SVG 矢量版");
    } finally {
      setRendering(false);
    }
  };

  const downloadSvg = () => {
    downloadText(`${slug}-poster-${format}-${theme}${draftSuffix}.svg`, posterSvg, "image/svg+xml;charset=utf-8");
    toast(reviewed ? "已导出矢量宣传海报 SVG（可直接在 Figma / Illustrator 编辑）" : "已导出未审校初稿海报 SVG");
  };

  const previewLanding = () => {
    const url = URL.createObjectURL(new Blob([landingHtml], { type: "text/html;charset=utf-8" }));
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const downloadLanding = () => {
    downloadText(`${slug}-launch-page-${theme}${draftSuffix}.html`, landingHtml, "text/html;charset=utf-8");
    toast(reviewed ? "已下载独立站落地页 HTML（双击浏览器打开或直接部署）" : "已下载未审校初稿落地页 HTML");
  };

  const downloadSocialAll = () => {
    const md = socialPosts.map((s) => `## ${s.platform}\n\n${s.content}`).join("\n\n---\n\n");
    downloadText(`${slug}-social-launch-kit${draftSuffix}.md`, md);
    toast(reviewed ? "已下载海外社媒宣传文案包" : "已下载未审校初稿社媒文案包");
  };

  const open = pack?.open.length ?? promo.openCount;
  const draftText = pack?.draft ? [pack.draft.title, "", ...pack.draft.outline.map((o, i) => `${i + 1}. ${o}`)].join("\n") : "";
  const hasContent = ws.assets.length > 0;

  return (
    <dialog className="drawer drawer-wide" ref={ref} aria-labelledby="exportTitle" onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
      <div className="dlg-h">
        <span className="itile sm"><Icon name="box" /></span>
        <h2 id="exportTitle">最终交付与宣传物料 <small className="muted" style={{ fontSize: 13, fontWeight: 500 }}>/ Launch Deliverables</small></h2>
        {ws.is_demo && <span className="tag t-demo">{DEMO_TAG}</span>}
        {!reviewed && hasContent && <span className="tag t-need">未审校初稿</span>}
        <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" onClick={() => ref.current?.close()}><Icon name="x" /></button>
      </div>

      <div className="exp-tabs" role="tablist" aria-label="导出格式">
        <button type="button" role="tab" aria-selected={tab === "poster"} onClick={() => setTab("poster")}><Icon name="sparkle" small />宣传海报 (PNG/SVG)</button>
        <button type="button" role="tab" aria-selected={tab === "landing"} onClick={() => setTab("landing")}><Icon name="globe" small />独立站落地页 (HTML)</button>
        <button type="button" role="tab" aria-selected={tab === "social"} onClick={() => setTab("social")}><Icon name="megaphone" small />海外社媒文案包</button>
        <button type="button" role="tab" aria-selected={tab === "docs"} onClick={() => setTab("docs")}><Icon name="doc" small />Markdown 与审校报告</button>
      </div>

      <div className="dlg-b">
        {!hasContent ? (
          <div className="state need">
            <Icon name="alert" />
            <span className="grow">还没有生成海外内容。请先完成前面的步骤（提取事实 → 知乎洞察 → 生成海外内容），再导出宣传海报与交付包。</span>
          </div>
        ) : (
          <>
            {!reviewed ? (
              <div className="state need">
                <Icon name="alert" />
                <span className="grow">尚未执行第 4 步「发布前合规审校」。当前内容为<b>未审校初稿</b>（可能仍含未改写的夸大或风险说法），建议先完成审校再正式对外发布。</span>
                <button type="button" className="btn btn-sm btn-primary" onClick={onGoReview}>去执行审校</button>
              </div>
            ) : open > 0 ? (
              <div className="state need">
                <Icon name="hand" />
                <span className="grow">还有 {open} 件事没决定。现在导出也可以，未确认数值会显示为 <b>[待确认]</b>；决定后海报和落地页会自动更新。</span>
                <button type="button" className="btn btn-sm" onClick={onDecide}>先去决定</button>
              </div>
            ) : (
              <div className="state ok">
                <Icon name="checkCircle" />
                <span className="grow">已完成发布前审校且所有事项均已确认，以下宣传海报、独立站页面、社媒文案与审校报告均可直接用于发布。</span>
              </div>
            )}

            {tab === "poster" && (
              <div className="stack" style={{ gap: 14 }}>
                <div className="poster-controls">
                  <div>
                    <span className="ctrl-label">画幅尺寸</span>
                    <div className="seg-group">
                      {(Object.keys(FORMAT_META) as PosterFormat[]).map((f) => (
                        <button key={f} type="button" className={format === f ? "on" : undefined} onClick={() => setFormat(f)}>
                          {FORMAT_META[f].label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="ctrl-label">视觉主题</span>
                    <div className="seg-group">
                      {(Object.keys(THEME_META) as PosterTheme[]).map((t) => (
                        <button key={t} type="button" className={theme === t ? "on" : undefined} onClick={() => setTheme(t)}>
                          <span className="swatch" style={{ background: THEME_META[t].swatch }} />
                          {THEME_META[t].label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="muted" style={{ margin: "-6px 0 0", fontSize: 12.5 }}>
                  当前画幅：{FORMAT_META[format].desc} · 海报内容与你在工作台确认的重量、卖点及合规改写实时同步。
                </p>
                <div className={`poster-stage ${format}`}>
                  <div className="poster-frame" dangerouslySetInnerHTML={{ __html: posterSvg }} />
                </div>
              </div>
            )}

            {tab === "landing" && (
              <div className="stack" style={{ gap: 14 }}>
                <div className="poster-controls">
                  <div>
                    <span className="ctrl-label">页面主题</span>
                    <div className="seg-group">
                      {(Object.keys(THEME_META) as PosterTheme[]).map((t) => (
                        <button key={t} type="button" className={theme === t ? "on" : undefined} onClick={() => setTheme(t)}>
                          <span className="swatch" style={{ background: THEME_META[t].swatch }} />
                          {THEME_META[t].label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <button type="button" className="btn btn-sm" onClick={previewLanding}><Icon name="external" small />新窗口全屏预览</button>
                  </div>
                </div>
                <p className="muted" style={{ margin: "-6px 0 0", fontSize: 12.5 }}>
                  单文件响应式 HTML5 落地页（含 Hero 视觉、核心卖点、产品故事、技术参数表、折叠 FAQ 与合规声明），无需外部依赖，双击即开或直接上传部署。
                </p>
                <iframe title="独立站落地页预览" className="landing-preview" sandbox="" srcDoc={landingHtml} />
              </div>
            )}

            {tab === "social" && (
              <div className="stack" style={{ gap: 14 }}>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  {reviewed ? "基于已审校的事实与本地化写法生成，可直接复制到海外社媒发布。" : "当前基于未审校初稿生成，建议先执行发布前审校再对外发布。"}
                </p>
                {socialPosts.map((post) => (
                  <article key={post.id} className="glass-inner social-card">
                    <div className="social-head">
                      <div><b>{post.platform}</b><small>{post.subtitle}</small></div>
                      <button type="button" className="btn btn-sm" onClick={() => copy(post.id, post.content)}>
                        <Icon name={copied === post.id ? "check" : "copy"} small />{copied === post.id ? "已复制" : "复制全部"}
                      </button>
                    </div>
                    {post.tweets ? (
                      <div className="stack" style={{ gap: 8 }}>
                        {post.tweets.map((tw, idx) => (
                          <div key={idx} className="glass-inner" style={{ padding: "10px 12px" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                              <span className="muted" style={{ fontSize: 12 }}>第 {idx + 1} 条 · {tw.length}/280 字符</span>
                              <button type="button" className="btn btn-sm btn-ghost" onClick={() => copy(`${post.id}-${idx}`, tw)}>
                                <Icon name={copied === `${post.id}-${idx}` ? "check" : "copy"} small />{copied === `${post.id}-${idx}` ? "已复制" : `复制 ${idx + 1}/${post.tweets!.length}`}
                              </button>
                            </div>
                            <pre className="md" style={{ maxHeight: 160 }}>{tw}</pre>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <pre className="md">{post.content}</pre>
                    )}
                  </article>
                ))}
              </div>
            )}

            {tab === "docs" && (
              !pack ? <p className="muted">正在整理…</p> : (
                <>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <b style={{ fontSize: 15 }}>英文产品页面</b>
                      <span className="muted" style={{ fontSize: 12.5 }}>English Product Page · Markdown，可直接贴进 Kickstarter 编辑器</span>
                    </div>
                    <pre className="md">{pack.markdown}</pre>
                  </div>
                  <div>
                    <b style={{ fontSize: 15, display: "block", marginBottom: 8 }}>一起生成好的</b>
                    <ul className="extras">
                      <li><details><summary><span className="itile sm"><Icon name="doc" /></span><span><b>审校报告</b><small>Review Report · 系统改了什么、为什么、你决定了什么、还缺什么</small></span><Icon name="down" /></summary>
                        <div className="inner"><pre className="md">{pack.report}</pre></div></details></li>
                      {pack.glossary && <li><details><summary><span className="itile sm teal"><Icon name="file" /></span><span><b>中英口径表</b><small>给客服、KOL 和海外代理商统一说法</small></span><Icon name="down" /></summary>
                        <div className="inner"><table className="tbl"><thead><tr><th>中文说法</th><th>对外英文说法</th><th>不要说</th></tr></thead>
                          <tbody>{ws.brief.glossary.map((g) => <tr key={g[0]}><td>{g[0]}</td><td className="en">{g[1]}</td><td>{g[2]}</td></tr>)}</tbody></table></div></details></li>}
                      {pack.draft && <li><details><summary><span className="itile sm zhi">知</span><span><b>知乎知识回流草稿</b><small>Zhihu Knowledge Feedback Draft · 系统不会替你发布</small></span><Icon name="down" /></summary>
                        <div className="inner draft">
                          <h4>{pack.draft.title}</h4><p className="muted" style={{ margin: 0, fontSize: 13 }}>{pack.draft.meta}</p>
                          <ol>{pack.draft.outline.map((o) => <li key={o}>{o}</li>)}</ol>
                          <ul className="checks">{pack.draft.checks.map(([c, who], i) => who === "system"
                            ? <li key={c}><Icon name="check" small />{c}（系统已查）</li>
                            : <li key={c}><input type="checkbox" id={`ck${i}`} /><label htmlFor={`ck${i}`}>{c}（只有你能确认）</label></li>)}</ul>
                          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                            <button type="button" className="btn btn-sm" onClick={() => copy("draft", draftText)}><Icon name={copied === "draft" ? "check" : "copy"} small />{copied === "draft" ? "已复制" : "复制草稿"}</button>
                            <a className="btn btn-sm" href="https://www.zhihu.com/" target="_blank" rel="noopener noreferrer"><Icon name="external" small />打开知乎，自己决定是否发布</a>
                          </div>
                        </div></details></li>}
                    </ul>
                  </div>
                </>
              )
            )}
          </>
        )}
      </div>

      <div className="dlg-f">
        {tab === "poster" && (
          <>
            <button type="button" className="btn" disabled={!hasContent} onClick={downloadSvg}><Icon name="download" small />导出矢量 SVG{reviewed ? "" : "（初稿）"}</button>
            <button type="button" className="btn btn-primary" disabled={!hasContent || rendering} onClick={downloadPng}>
              {rendering ? <span className="spin" /> : <Icon name="download" small />}下载高清宣传海报 (.png{reviewed ? "" : " · 初稿"})
            </button>
          </>
        )}
        {tab === "landing" && (
          <>
            <button type="button" className="btn" disabled={!hasContent} onClick={previewLanding}><Icon name="external" small />新窗口预览</button>
            <button type="button" className="btn btn-primary" disabled={!hasContent} onClick={downloadLanding}><Icon name="download" small />下载独立站落地页 (.html{reviewed ? "" : " · 初稿"})</button>
          </>
        )}
        {tab === "social" && (
          <button type="button" className="btn btn-primary" disabled={!hasContent} onClick={downloadSocialAll}><Icon name="download" small />下载社媒文案包 (.md{reviewed ? "" : " · 初稿"})</button>
        )}
        {tab === "docs" && (
          <>
            <button type="button" className="btn" disabled={!pack || !hasContent} onClick={() => pack && copy("md", pack.markdown)}>
              <Icon name={copied === "md" ? "check" : "copy"} small />{copied === "md" ? "已复制" : "复制英文页"}
            </button>
            <button type="button" className="btn btn-primary" disabled={!pack || !hasContent} onClick={() => {
              if (!pack) return;
              downloadText(`${slug}-launch-pack${draftSuffix}.md`, [pack.markdown, pack.report, pack.glossary].filter(Boolean).join("\n\n---\n\n"));
              toast(reviewed ? "已下载发布包（英文页 + 审校报告 + 中英口径表）" : "已下载未审校初稿发布包");
            }}><Icon name="download" small />导出 Markdown（{reviewed ? "全部" : "初稿"}）</button>
          </>
        )}
      </div>
    </dialog>
  );
}
