# 留白 · A/B 交互样板

这是独立可操作的设计样板。A「静纸」与 B「流光」共用布局、任务和操作逻辑，便于比较反馈与材质。使用示例数据，保存在当前浏览器的 localStorage（`liubai-motion-study-v1`），不连接正式应用数据库。

## 打开

在项目根目录执行：

```sh
python3 -m http.server 8914 --bind 127.0.0.1 --directory design/motion-study
```

访问 <http://127.0.0.1:8914>。

## 体验顺序

1. 顶部切换 A / B，点击「重播入场」比较进入页面的节奏。
2. 点击任务查看详情；打开过程中也可关闭或切换任务。
3. 将待安排任务拖入课表；默认按 5 分钟吸附，按住 Alt 精确到分钟。拖底边调整时长，Escape 取消拖动。
4. 聚焦课表任务后用上下方向键移动 1 分钟，Shift 加方向键移动 5 分钟。详情中的时间输入也支持精确安排与冲突检查。
5. 开始专注，暂停、恢复、结束；完成任务再撤销，确认实际专注时间保留。
6. 试用新建任务、切换日期、刷新恢复、减少动态及系统深色模式。

## 验证与边界

`verify.cjs` 使用 Playwright 检查真实鼠标拖动、时长调整、冲突回退、详情中断、计时、撤销、持久化和 320–1440 像素宽度。测试在独立浏览器上下文中运行。先保持上述预览服务运行，在另一个终端安装可选依赖并执行：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node design/motion-study/verify.cjs
```

默认使用 Playwright 的 Chromium。已有 Chrome 时可通过 `CHROME_PATH` 指定可执行文件；已有 Playwright 时可通过 `PLAYWRIGHT_MODULE` 指定模块路径。`PREVIEW_URL` 可改变预览地址，`SCREENSHOT_DIR` 可改变截图位置。检查生成的截图默认写入被 Git 忽略的 `test-results/motion-study/`，不会覆盖本目录保存的历史预览。

中文优先使用本机安装的思源宋体；未安装时回退至宋体或衬线字体。英文和数字使用系统字体。玻璃是 Web 材质近似，不等同于 Apple 原生 Liquid Glass。已提供触屏拖动手柄及点击安排入口，尚未在真实手机上验证手势；中文输入测试为组合事件模拟。截图及自动检查不能替代主观手感评审。

样例日期固定为 2026 年 9 月 23 日；时段为 08:00–20:00。任务完成与实际计时分别保存，撤销完成只恢复完成状态。
