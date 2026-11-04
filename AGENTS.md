0. 容器里要装好 OpenCode 和 OpenChamber(Vendor对应的版编译之后安装)。
1. 整个deliver的结果应该尽可能少的侵入到原来的code, 尽量复用一些比较稳定的接口，UX要顺滑，UI的风格要统一。
3. Agent 本身不能改 `./vendors` 里的任何字节，它只由 `mise run vendors:update` 更新：这个脚本手动运行，把 vendor 升到最新的正式 release，跑完全部检查才提交 pin。检查不过就去改 adapters、测试或者这个脚本，不改 vendor。去掉一个 vendor 只能由我决定：把它从 `vendors.json` 里删掉，同时 `git rm` 它的 submodule（`.gitmodules` 里那一节一起去掉），在同一个提交里做，比如 2026-11-04 去掉 VS Code。
4. 主要的工作都在 `./extensions` 里，这里的插件要装在 OpenChamber 最新的 release 上用。这些插件都要做到：
   - 不破坏 OpenChamber 原有的功能。
   - 在 OpenChamber 里，切换 tab 这类快捷键先由 OpenChamber 处理，不能被 Chrome 拿走：按下去切换的是 OpenChamber 的 tab，不是 Chrome 的标签页。焦点在插件里的时候，比如正在 Planner 里面那么快捷键就应该被 Planner 接管。有些键 Chrome 在普通标签页里留给自己，网页拿不到（比如 Ctrl+Tab、Cmd+Option+←/→、Cmd+W），这些键只要求在 OpenChamber 装成 app 窗口时做到。
   - 我在使用`cmd + click`的时候，应该能够在chrome打开一个新的标签页，而不是直接在当前的标签页占到新的view。
## 2.i Planner（`./extensions/planner`）

整合下面这些功能，UX 也要和对应的产品类似。

- a. Calendar 和 task：Google Calendar 和 Google Tasks 联动起来能做的所有功能。
- b. 从别处加 task：像 Sunsama 一样，能把 Linear issue、GitHub issue 和 Email 加进 task 里。
- c. Linear 和 agent：
  - 能直接加载 Linear 里已经存好的 view，也能像在 Linear 里一样临时 filter。
  - 能直接修改 Linear issue 的内容。
  - 能像在 GitHub 或 Linear 里一样，直接把 task assign 给某个 agent；开了新的 worktree agent在里面工作，如果做了修改就commit之后提PR。

这一阶段 Planner 的数据可以只存在openchamber server本地，不要求同步到 GitHub。
