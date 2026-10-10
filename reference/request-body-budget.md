# Request body byte budgets / 请求体字节预算

HTTP model requests have three separate byte boundaries:

| Stage | Limit | Failure |
| --- | --- | --- |
| Raw HTTP reception | 100 MiB | 413, `request_too_large`, `stage: receive` when the socket permits a response |
| Decompression of recognized model protocols | 200 MiB per decoding stage | 413, `request_too_large`, `stage: decode` |
| Rebuilt upstream body | 100 MiB of UTF-8 / Buffer bytes | 413, `request_too_large`, `stage: forward` before initial send |

Only two requests whose decoded body crosses 100 MiB may be active in one proxy process. A third receives 503 `request_body_busy`, `stage: decode`, `Retry-After: 1`, without being forwarded. Its slot is released on completion or cancellation. Ordinary requests do not use these slots. The limit bounds the **additional large decoded payloads**, not total process RSS: buffers, JSON parsing, session state and ordinary concurrent requests also consume memory. Streaming codecs stop on cancellation and enforce the cap while decoding; synchronous zstd can only observe cancellation at its synchronous checkpoints.

This permits a gzip / zstd / Brotli-compressed history slightly above 100 MiB to reach existing explicit reductions. It does not enable `compress.stripImages` or image compression. If the rebuilt body remains over 100 MiB, it is refused; retries cannot bypass the send guard. Already-started SSE responses deliver the failure through the existing error channel instead of changing committed headers. Budget diagnostics report sizes/stages, without request text or pixels.

Configure the existing `compress.stripImages` / `compress.stripImagesKeepRecent` policy only when historical-image removal is appropriate. The recent setting counts **messages**, not individual images. Existing image-archive / retrieval behavior, including its failure limitations, is unchanged; this is not a lossless-image lifecycle repair. Passthrough-marked or unrecognized compressed requests keep their original bytes and the raw 100 MiB limit. Uncompressed HTTP bodies above 100 MiB and WebSocket limits are unchanged. Byte limits do not replace model token-window checks or establish an upstream's accepted maximum.

HTTP 请求分成三道字节边界：原始接收 100 MiB；已识别模型协议每层解压最多 200 MiB；重建后发送正文最多 100 MiB。只有两个超过旧解压上限的请求能同时占用名额，第三个在解压阶段返回可重试的 503，完成或取消后释放。该名额限制额外超大正文，不是整个进程的 RSS 上限。

此修复让略超旧限制的压缩历史进入已有、显式开启的减量流程，不会自动删除图片或开启缩图。减量后仍过大时，在正式上游发送前拒绝；流已经开始时使用现有错误事件。历史图片保留策略仍由 `stripImages` 与 `stripImagesKeepRecent` 决定，后者计数单位是消息。原图归档失败等既有生命周期问题另行处理，不能把本修复视为无损恢复保证。未压缩大正文、WebSocket、透传行为和模型 token 窗口保持原有边界。
