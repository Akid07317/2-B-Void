# 开发与仓库维护

本项目的应用运行依赖只有 Python 3.11+ 标准库；Node 用于 JavaScript 检查，不参与后端运行。GitHub 自动检查覆盖 Python 3.11 / 3.14 和 Node 22。

## 启动与检查

在仓库根目录运行：

```sh
python3 -m planner.server --port 8765
sh scripts/check.sh
```

检查脚本运行全部 Python 回归、应用及设计样板的 JavaScript 语法检查、秒级时间统计断言；任一步失败都会停止。可以通过 `PYTHON` 和 `NODE` 环境变量指定运行时。HTTP 回归需要允许监听本机回环端口，数据库使用临时目录。

做界面试验时另开终端、指定独立数据库：

```sh
python3 -m planner.server --port 8766 --db /tmp/liubai-preview.sqlite3
```

`data/planner.sqlite3` 是正式本机数据。界面样板位于 [design/motion-study](../design/motion-study/README.md)，只用示例数据和浏览器 localStorage。样板的可选 Playwright 检查需要额外浏览器依赖，运行方法见其说明。

## 仓库边界

纳入版本控制：`planner/`、`tests/`、`scripts/`、`.github/`、开发规格与研究文档、`design/motion-study/`。应用不读取根目录的个人学习计划或研究导出。

个人课表、学习记录、教材资料、生成器、原始评审包和 ZIP 检查点保留在本地原位置，并由 `.gitignore` 明确排除。运行数据库、依赖目录、凭据和缓存也不提交。需要同步这些资料时，应单独决定存储位置和公开范围。

历史验证文档及文件哈希对应其标注日期的代码快照。当前验证记录见 [首次提交检查](REPOSITORY_CHECK_CN.md)，已知行为限制见 [待修复问题](KNOWN_ISSUES_CN.md)。回归通过不能替代完整验收合同、浏览器交互或真实学习效果验证。
