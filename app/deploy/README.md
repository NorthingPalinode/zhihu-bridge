# deploy/

本阶段**不部署**到公网（V6 P0-10 在当前范围内只做“本地实现 + 本地测试”）。

日后部署时需要注意（V6 §6.1、§6.8）：

- 单实例、单 worker 运行 uvicorn，前面加 HTTPS 同源反向代理；
- 反代关闭 SSE 缓冲（例如 Nginx 的 `proxy_buffering off;`，后端已经返回 `X-Accel-Buffering: no`），并适当调大读超时；
- 把反代地址写入 `TRUSTED_PROXY_IPS`，后端只信任它转发的 `X-Forwarded-For`；
- 所有密钥只通过服务端环境变量注入，提交前运行 `server/scripts/scan_secrets.py`。

这里没有提供可直接上线的配置，因为云主机、域名和证书都还未确定（V6 U-05）。
