0. 容器里要装好 OpenCode、OpenChamber 和 VS Code Server(Vendor对应的版编译之后安装)。
1. 整个deliver的结果应该尽可能少的侵入到原来的code, 尽量复用一些比较稳定的接口，UX要顺滑，UI的风格要统一。
3. Agent 本身不能改 `./vendors` 里的任何字节，它只由 CI 更新。如果CI有问题那么应该去修改CI。
4. 主要的工作都在 `./extensions` 里，这里的插件要装在 OpenChamber 最新的 release 上用。这些插件都要做到：
   - 不破坏 OpenChamber 原有的功能。
   - 在 OpenChamber 里，切换 tab 这类快捷键先由 OpenChamber 处理，不能被 Chrome 拿走：按下去切换的是 OpenChamber 的 tab，不是 Chrome 的标签页。焦点在插件里的时候，比如正在 VS Code 里面那么快捷键就应该被VS Code接管。有些键 Chrome 在普通标签页里留给自己，网页拿不到（比如 Ctrl+Tab、Cmd+Option+←/→、Cmd+W），这些键只要求在 OpenChamber 装成 app 窗口时做到。
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

## 2.ii VS Code（`./extensions/vscode`）

写一些中间组件，把已经编译好的 VS Code 直接渲染在 OpenChamber 里面（不是另外打开一个网页），包括但不限于代码的渲染。OpenChamber 自己的 Files 视图保持原样，下面这些是 VS Code 另加的一套，不替换它。

- a. Extension 图标放进 OpenChamber 的侧边栏：在内嵌 VS Code 里安装的 extension，要直接出现在 OpenChamber 的侧边栏里，也就是 Planner 和 VS Code 图标所在的那一列。VS Code 的 activity bar 上每有一个 extension 的图标，OpenChamber 这一列里就要有一个对应的图标。点开它，打开的就是这个 extension 自己的界面，用起来和在 VS Code 里一样。这些图标在运行时动态加载，跟着 VS Code 里装了哪些 extension 变：装上就出现，卸载就消失，不用改代码，也不用重装 OpenChamber 插件或重启。VS Code 自带的 Explorer、Search、Source Control、Run and Debug、Extensions 也一样要放进 OpenChamber 的侧边栏。
- b. 文件 tab 放到 OpenChamber 顶部：在内嵌 VS Code 里打开文件时，文件的 tab 不留在 VS Code 面板自己的 tab 栏里，而是直接出现在 OpenChamber 顶部的 tab 栏，和 chat 的 tab 排在一起。点这个 tab，主区域就加载这个文件的编辑器，就像点 chat tab 会加载对话一样。它也能像 chat tab 一样切换和关闭。
- c. Terminal 开在 OpenChamber 底部：VS Code 的 terminal 要能整个开在 OpenChamber 的底部，用起来和现在的 VS Code 一样，比如能开多个 terminal、拆分、选 shell。不用为了用 terminal 把整个 VS Code 开在侧面。
