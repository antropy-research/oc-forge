0. Containers里面应该安装了opencode, openchamber, and vs code server.

1. Agents should never change any bytes in `./vendors`, it should be updated by ci.

2. `./extensions` is where we mainly work, and this extension is used to installed on latest Openchamber's release. 这里面的任何插件都不要破坏Openchamber原有的功能。

在 OpenChamber 里，切换 tab 这类快捷键先由 OpenChamber 处理，不能被 Chrome 拿走：按下去切换的是 OpenChamber 的 tab，不是 Chrome 的标签页。焦点在插件里的时候也一样，比如正在 VS Code 里打字。

  i. `./extensions/planner`需要integrate了(UX也需要和相应的工作类似):
    a. calenader and task: 像是gcal和google task可以一起联动的所有功能。
    b. Sunsama 一样可以把Linear issue/Github issues/Email给加入到task里面来的能力。
    c. 可以直接load Linear里面已经保存好的view以及像是linear一样可以临时的去filter一些东西。可以直接修改linear issue的内容。可以直接像是github或者是linear里面一样把task assign给某个agent，然后对应的agent直接开了worktree之后提pr。
   ii. `./extensions/vscode`应该写了一些中间组建，可以把已经编译好的vscode给渲染到openchamber里面来(不是再单独打开一个网页)，包括但是不限于代码的渲染等等。
     a. 在内嵌 VS Code 里安装的 extension，要直接出现在 OpenChamber 的侧边栏里，也就是 Planner 和 VS Code 图标所在的那一列。VS Code 的 activity bar 上每有一个 extension 的图标，OpenChamber 这一列里就要有一个对应的图标。点开它，打开的就是这个 extension 自己的界面，用起来和在 VS Code 里一样。这些图标在运行时动态加载，跟着 VS Code 里装了哪些 extension 变：装上就出现，卸载就消失，不用改代码，也不用重装 OpenChamber 插件或重启。VS Code 自带的 Explorer、Search、Source Control、Run and Debug、Extensions也一样需要放在OPenchamber的侧边栏。
     b：文件 tab 放到 OpenChamber 顶部。在内嵌 VS Code 里打开文件时，文件的 tab 不留在 VS Code 面板自己的 tab 栏里，而是直接出现在 OpenChamber 顶部的 tab 栏，和 chat 的 tab 排在一起。点这个 tab，主区域就加载这个文件的编辑器，就像点 chat tab 会加载对话一样。它也能像 chat tab 一样切换和关闭。
     