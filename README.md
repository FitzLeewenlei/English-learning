# 海纳教育·英语重点词点读

顶部菜单 Unit 1–Unit 120 均有内容，每个单元包含 15 个词条和 15 组真题例句、译文，共 1,800 个词条、1,800 组例句。原 Unit 1–32 保留《Unit1-Unit32 .docx》的既有内容与录音，新增 Unit 33–120 来自《重点单词汇总.docx》，没有覆盖旧单元。页头使用海纳教育徽标。

“01 单词”中的单词、音标、词性和中文释义逐字采用文档内容，仅发音来自有道。`addict`、`present` 的两种读音及对应词性标记也按原文保留。

“02 真题例句”的英文、中文译文、词形批注和真题出处均来自文档。点击句中单词打开词卡，音标、词性、每种词性一两个重点中文释义及单词发音来自有道。音标不加“英”前缀，按钮统一显示“发音”。缺少的有道字段会明确标注；单词区的文档音标不会用于冒充有道词卡音标。

单词区可点读或依次朗读；例句可点喇叭播放整句或依次朗读。速度支持 0.5×、0.75×、1.0×、1.25×，并记住选择。单元选择也会保留。

整句播放时，当前英文居中放大，背景模糊，文字随音频时间由白色推进为蓝色。下方为后退 5 秒、暂停／继续、前进 5 秒；支持左右方向键和 Esc 关闭。中文批注和考试出处在页面中显示，但不读入音频。长句与手机横竖屏均适配，字幕区域必要时单独滚动。

整句录音复用文字一致的既有录音，其余使用 Sonia 英式语音生成，并保存语音服务返回的词边界。复合事件拆成多个显示词元时会在数据中标记估计区间。所有 1,800 条例句均有离线录音与时间数据，相同句子复用已校验的录音；原有 480 条记录及其音频路径、校验和与时间区间保持不变。浏览器只读取本地静态数据和音频，无需实时连接有道或语音服务。

合并后的文档来源与逐段索引保存在 `data/course-units1-120.json`，来源明确区分两个文档及对应单元范围，包含 1,800 条词条原文、1,800 组例句／译文／出处及批注位置。旧提取 `data/course-units1-32.json` 原样保留，`data/preserved-units1-32.json` 记录本次扩充前的可信指纹。`content.js` 是面向页面的构建结果，不能直接改写文档事实。

`dictionary.js` 提供有道词卡资料与单词音频路径；`data/youdao-course.json` 保存查询结果、缺项、来源 URL、采集时间、原始响应 SHA-256、词条字段投影和音频校验和。音频保留有道实际返回的 MP3 或 WAV。旧版本资料与音频保留用于来源复用，页面以当前构建的词条路径为准。

首页只加载 `course-index.js` 中的 Unit 1 和菜单，课程脚本从原先约 3.6 MB 缩减至约 94 KB（传输时还会压缩）。切换单元时，仅请求对应的 `data/units/unit-单元号-内容哈希.json`，其中包含该单元正文、所需有道词卡和字幕时间；本次访问内已经加载的单元直接复用。构建保留旧哈希文件，使已打开的页面在后续更新后仍可切换单元。上次选择的其他单元会在打开时恢复，等待期间显示加载状态，失败时保留当前内容并可重新选择重试。页面稳定显示后，只优先准备当前屏幕附近至多 4 个重点词和 2 条例句；指向、按下或聚焦播放控件以及打开词卡时，也会提前准备对应音频。浏览器省流量模式下跳过预加载。完整聚合脚本保留供构建和资料一致性检查，首页不再下载它们。

完整课程涉及 3,905 个查询词形；1,800 次文档重点词展示对应 1,782 个不同单词，其有道发音全部齐备。有道未提供的例句词形字段会照实提示，查询及缺项统计见来源审计。返回原形的部分条目可显示有道原形释义，但不会将原形音标或录音冒充当前变形。

`audio/course-examples/manifest.json` 逐单元绑定 1,800 条例句与录音、校验和及词元时间；新录音旁的 JSON 保存原始词边界和语音参数。`sentence-timings.js` 是浏览器使用的时间映射。

本地开发无需构建后端。云环境已有 Python、aiohttp、Node.js、Playwright、Chromium。在仓库根目录运行 `python3 tools/serve.py --port 8003`。此服务器支持 HTTP Range，能验证音频快进／后退；Python 自带的 `http.server` 不适合验证 MP3 跳转。线上继续使用 GitHub Pages：
https://fitzleewenlei.github.io/English-learning/

播放优先复用已准备好的录音 Blob；准备失败时立即使用原始音频地址，缓存解码失败时也会回退，点击操作中不等待异步下载后才调用播放。预加载最多同时 2 个请求，内存缓存最多 6 MiB／48 项，切换单元会取消未完成的旧准备任务。依次朗读时只额外准备接下来的 2 条。

`data/audio-starts.json` 保存全部源录音的 SHA-256 与安全播放起点。`tools/build_audio_starts.py` 检查两声道首个高于约 −70 dBFS 的活动，保留至少 80 ms 前导，最多跳过 0.45 秒；原始有道和整句音频保持原样。浏览器在媒体元数据就绪时跳到该起点，字幕继续使用原音频时间轴。添加或修改录音后先运行 `python3 -B tools/build_audio_starts.py`，现有审计可用 `--check` 核验，再构建课程分包。

首页按站点所有者提供的代码接入 Cloudflare Web Analytics，统计主机名为 `fitzleewenlei.github.io`。统计脚本以模块方式加载；浏览数据在 Cloudflare 控制台的 Web Analytics 中查看，从接入后开始记录。访问次数不等于去重学生人数，此统计也不提供 GitHub Pages 的每月流量用量。浏览器或网络阻止统计脚本时，点读功能仍可独立运行。

保持服务运行，在另一终端运行：

```bash
node tests/course.smoke.cjs
node tests/youdao.smoke.cjs
node tests/playback.smoke.cjs
node tests/loading.smoke.cjs
node tests/audio-latency.smoke.cjs
```

课程检查核对全部 120 个单元、1,800 个词条与 1,800 组例句的文档一致性、菜单、录音绑定及手机排版，并用可信指纹验证原 Unit 1–32 未被更改。有道检查验证来源、缺项、音频校验和及解码。播放检查验证自然结束切换、字幕进度、暂停、跳转、0.5× 和手机横屏。加载检查验证各单元包与完整资料一致、首页不加载整库、音频准备仅限当前单元的少量可见内容、切换缓存、快速切换时序、失败重试和单元恢复。可通过 `TEST_BASE_URL`、`CHROMIUM_PATH` 指定服务和浏览器路径；截图写入临时目录。

更新当前资料的流程如下，来源文件路径须指向用户提供的实际文档：

```bash
python3 -B tools/import_course_docx.py "/path/to/重点单词汇总.docx" \
  --expected-units 120 --keep-units-from data/course-units1-32.json \
  --keep-through 32 --output data/course-units1-120.json
python3 -B tools/import_youdao_course.py --plan
python3 -B tools/import_youdao_course.py --fetch
python3 -B tools/import_youdao_course.py --build
```

有道导入器限速访问官方 HTTPS 地址，复用经校验的缓存，默认把原始响应暂存在 `/tmp/english-learning-youdao/`；显式 `--build` 才更新页面词典、来源审计和新增单词音频。单词区文字始终由文档构建器负责。

整句录音的可重复生成器为 `tools/generate_course_audio.py`，构建时需要隔离安装 `edge-tts==7.3.1` 和 ffmpeg／ffprobe，按脚本说明运行。它保留代理和证书验证、支持缓存续跑与有限重试。生成后用 `--check` 离线验证；运行时不需要安装语音合成包。旧版强制对齐脚本只用于历史录音。

所有录音准备完成后执行 `python3 -B tools/build_course.py`，重新生成 `content.js`、`sentence-timings.js`、`course-index.js` 和各单元数据包。正常构建会拒绝缺少录音或词边界的课程；`--allow-pending-audio` 仅用于本地界面开发，不能作为发布检查。再运行上述检查后发布到 GitHub。

原有 `vocabulary.html` 为独立历史页面。
