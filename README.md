# 海纳教育·英语重点词点读

顶部菜单 Unit 1–Unit 120 均有内容，每个单元包含 15 个词条和 15 组真题例句、译文，共 1,800 个词条、1,800 组例句。原 Unit 1–32 保留《Unit1-Unit32 .docx》的既有内容与录音，新增 Unit 33–120 来自《重点单词汇总.docx》，没有覆盖旧单元。页头使用海纳教育徽标。

“01 单词”中的单词、音标、词性和中文释义逐字采用文档内容，仅发音来自有道。`addict`、`present` 的两种读音及对应词性标记也按原文保留。

“02 真题例句”的英文、中文译文、词形批注和真题出处均来自文档。点击句中单词打开词卡，音标、词性、每种词性一两个重点中文释义及单词发音来自有道。音标不加“英”前缀，按钮统一显示“发音”。缺少的有道字段会明确标注；单词区的文档音标不会用于冒充有道词卡音标。

单词区可点读或依次朗读；例句可点喇叭播放整句或依次朗读。速度支持 0.5×、0.75×、1.0×、1.25×，并记住选择。单元选择也会保留。

整句播放时，当前英文居中放大，背景模糊，文字随音频时间由白色推进为蓝色。下方为后退 5 秒、暂停／继续、前进 5 秒；支持左右方向键和 Esc 关闭。中文批注和考试出处在页面中显示，但不读入音频。长句与手机横竖屏均适配，字幕区域必要时单独滚动。

整句录音复用文字一致的既有录音，其余使用 Sonia 英式语音生成，并保存语音服务返回的词边界。复合事件拆成多个显示词元时会在数据中标记估计区间。所有 1,800 条例句均有离线录音与时间数据，相同句子复用已校验的录音；原有 480 条记录及其音频路径、校验和与时间区间保持不变。浏览器只读取本地静态数据和音频，无需实时连接有道或语音服务。

合并后的文档来源与逐段索引保存在 `data/course-units1-120.json`，来源明确区分两个文档及对应单元范围，包含 1,800 条词条原文、1,800 组例句／译文／出处及批注位置。旧提取 `data/course-units1-32.json` 原样保留，`data/preserved-units1-32.json` 记录本次扩充前的可信指纹。`content.js` 是面向页面的构建结果，不能直接改写文档事实。

`dictionary.js` 提供有道词卡资料与单词音频路径；`data/youdao-course.json` 保存查询结果、缺项、来源 URL、采集时间、原始响应 SHA-256、词条字段投影和音频校验和。音频保留有道实际返回的 MP3 或 WAV。旧版本资料与音频保留用于来源复用，页面以当前构建的词条路径为准。

首页只加载 `course-index.js` 中的 Unit 1 和菜单，课程脚本从原先约 3.6 MB 缩减至约 87 KB（传输时还会压缩）。切换单元时，仅请求对应的 `data/units/unit-单元号-内容哈希.json`，其中包含该单元正文、所需有道词卡和字幕时间；本次访问内已经加载的单元直接复用。构建保留旧哈希文件，使已打开的页面在后续更新后仍可切换单元。上次选择的其他单元会在打开时恢复，等待期间显示加载状态，失败时保留当前内容并可重新选择重试。音频仍在点击播放时才请求。完整聚合脚本保留供构建和资料一致性检查，首页不再下载它们。

完整课程涉及 3,905 个查询词形；1,800 次文档重点词展示对应 1,782 个不同单词，其有道发音全部齐备。有道未提供的例句词形字段会照实提示，查询及缺项统计见来源审计。返回原形的部分条目可显示有道原形释义，但不会将原形音标或录音冒充当前变形。

`audio/course-examples/manifest.json` 逐单元绑定 1,800 条例句与录音、校验和及词元时间；新录音旁的 JSON 保存原始词边界和语音参数。`sentence-timings.js` 是浏览器使用的时间映射。

本地开发无需构建后端。云环境已有 Python、aiohttp、Node.js、Playwright、Chromium。在仓库根目录运行 `python3 tools/serve.py --port 8003`。此服务器支持 HTTP Range，能验证音频快进／后退；Python 自带的 `http.server` 不适合验证 MP3 跳转。线上继续使用 GitHub Pages：
https://leefitz19981027-dot.github.io/English-learning/

保持服务运行，在另一终端运行：

```bash
node tests/course.smoke.cjs
node tests/youdao.smoke.cjs
node tests/playback.smoke.cjs
node tests/loading.smoke.cjs
```

课程检查核对全部 120 个单元、1,800 个词条与 1,800 组例句的文档一致性、菜单、录音绑定及手机排版，并用可信指纹验证原 Unit 1–32 未被更改。有道检查验证来源、缺项、音频校验和及解码。播放检查验证自然结束切换、字幕进度、暂停、跳转、0.5× 和手机横屏。加载检查验证各单元包与完整资料一致、首屏没有整库或音频请求、切换缓存、快速切换时序、失败重试和单元恢复。可通过 `TEST_BASE_URL`、`CHROMIUM_PATH` 指定服务和浏览器路径；截图写入临时目录。

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
